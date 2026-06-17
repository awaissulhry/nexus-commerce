/**
 * ACP.2a — Anthropic tool-use loop.
 *
 * Lets the model CHOOSE and chain the registry's tools to answer. The
 * AI-2 text abstraction (provider.generate) deliberately has no tool
 * calling, so this talks to the Anthropic Messages API directly with the
 * `tools` param. Read-only: a tool that requiresApproval returns its
 * dry-run preview to the model and NEVER executes (the approval gate +
 * real execution land in Phase 3). Step-capped to prevent runaway loops.
 *
 * Provider-specific by nature — Gemini function-calling is a follow-up;
 * the caller (runChat) falls back to a text-only answer on non-Anthropic.
 */

import { priceFor } from '../ai/rate-cards.js'
import { getTool, listTools } from './tool-registry.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import type { ToolContext } from './tool-types.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'

// Minimal JSON-schema args per tool so the model knows what to pass.
const SCHEMAS: Record<
  string,
  { properties: Record<string, unknown>; required?: string[] }
> = {
  'product-snapshot': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'product-search': {
    properties: {
      query: { type: 'string', description: 'name / SKU / brand fragment' },
      limit: { type: 'number' },
    },
  },
  'order-search': {
    properties: {
      marketplace: { type: 'string' },
      buyer: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  'order-detail': {
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  'stock-levels': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'price-status': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'listing-health': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'draft-listing-content': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'draft-seo': {
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  'translate-content': {
    properties: {
      productId: { type: 'string' },
      target: { type: 'string', description: 'target market language' },
    },
    required: ['productId', 'target'],
  },
  'draft-customer-message': {
    properties: { intent: { type: 'string' }, orderId: { type: 'string' } },
    required: ['intent'],
  },
  'set-price': {
    properties: {
      productId: { type: 'string' },
      price: { type: 'number' },
      channel: { type: 'string' },
    },
    required: ['productId', 'price'],
  },
  'publish-listing': {
    properties: { productId: { type: 'string' }, channel: { type: 'string' } },
    required: ['productId', 'channel'],
  },
  'send-customer-message': {
    properties: { orderId: { type: 'string' }, message: { type: 'string' } },
    required: ['orderId', 'message'],
  },
}

function anthropicTools() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: SCHEMAS[t.name]?.properties ?? {},
      required: SCHEMAS[t.name]?.required ?? [],
    },
  }))
}

export interface LoopStep {
  type: 'tool' | 'model'
  name: string
  args?: unknown
  result?: unknown
  ms: number
  costUSD?: number
}
export interface LoopResult {
  text: string
  steps: LoopStep[]
  inputTokens: number
  outputTokens: number
  costUSD: number
  stoppedAtCap: boolean
}

export interface LoopMessage {
  role: 'user' | 'assistant'
  content: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callClaude(
  model: string,
  system: string,
  messages: LoopMessage[],
  tools: unknown,
): Promise<any> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
    },
    // No temperature/thinking — keeps the call valid across the whole
    // Claude lineup (Opus 4.8 rejects sampling params).
    body: JSON.stringify({ model, max_tokens: 2048, system, messages, tools }),
  })
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return res.json()
}

// Inline policy-guarded execution (kept here to avoid an import cycle with
// the runtime). Read/draft run; requiresApproval tools return a preview.
async function execTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const policy = await resolveToolPolicy(name)
  const tool = getTool(name)
  if (!policy || !tool) return { error: `unknown tool: ${name}` }
  if (!policy.enabled) return { error: `tool ${name} is disabled` }
  const res = await tool.handler(input, ctx)
  if (policy.requiresApproval) {
    return {
      requiresApproval: true,
      preview: res.preview ?? res.data,
      note: 'Not executed — needs operator approval (coming in Phase 3).',
    }
  }
  return res.ok ? res.data : { error: res.error }
}

export async function runToolLoop(opts: {
  model: string
  system: string
  messages: LoopMessage[]
  ctx: ToolContext
  maxSteps?: number
}): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? 8
  const tools = anthropicTools()
  const messages: LoopMessage[] = [...opts.messages]
  const steps: LoopStep[] = []
  let inTok = 0
  let outTok = 0
  let cost = 0

  for (let i = 0; i < maxSteps; i++) {
    const t0 = Date.now()
    const res = await callClaude(opts.model, opts.system, messages, tools)
    const u = res.usage ?? {}
    const ci = Number(u.input_tokens ?? 0)
    const co = Number(u.output_tokens ?? 0)
    inTok += ci
    outTok += co
    const c = priceFor('anthropic', res.model ?? opts.model, ci, co)
    cost += c
    steps.push({
      type: 'model',
      name: res.model ?? opts.model,
      ms: Date.now() - t0,
      costUSD: c,
    })

    if (res.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: res.content })
      const toolResults: unknown[] = []
      for (const block of res.content ?? []) {
        if (block.type === 'tool_use') {
          const tt = Date.now()
          const result = await execTool(block.name, block.input ?? {}, opts.ctx)
          steps.push({
            type: 'tool',
            name: block.name,
            args: block.input,
            result,
            ms: Date.now() - tt,
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 6000),
          })
        }
      }
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    const text = (res.content ?? [])
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('')
    return {
      text,
      steps,
      inputTokens: inTok,
      outputTokens: outTok,
      costUSD: cost,
      stoppedAtCap: false,
    }
  }

  return {
    text: '(Reached the tool-step limit — partial work above.)',
    steps,
    inputTokens: inTok,
    outputTokens: outTok,
    costUSD: cost,
    stoppedAtCap: true,
  }
}

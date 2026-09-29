/**
 * MCP.3 — one input schema per tool, and nothing else describes a tool's
 * arguments.
 *
 * Before MCP.3 the assistant's tool list came from a hand-written map in
 * tool-loop.service.ts that four tools were missing from, so the model called
 * them blind. Now each tool carries its zod `input`: call-tool.ts parses every
 * call with it, and the model's JSON Schema is generated from it.
 */
import { describe, expect, it } from 'vitest'
import { listTools } from './tool-registry.js'
import { anthropicTools, inputJsonSchema } from './tool-loop.service.js'
import type { UserPrincipal } from './call-tool.js'

interface JsonObjectSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  $schema?: string
}

/**
 * The arguments the old hand-written map promised, for the tools it covered.
 * The generated schemas must keep every one of them. `set-price` drops
 * `channel`: the tool never read it (it sets the master price only), so
 * offering it told the model something false.
 */
const PROMISED: Record<string, { properties: string[]; required: string[] }> = {
  'product-snapshot': { properties: ['productId'], required: ['productId'] },
  'product-search': { properties: ['query', 'limit'], required: [] },
  'order-search': { properties: ['marketplace', 'buyer', 'status', 'limit'], required: [] },
  'order-detail': { properties: ['orderId'], required: ['orderId'] },
  'stock-levels': { properties: ['productId'], required: ['productId'] },
  'price-status': { properties: ['productId'], required: ['productId'] },
  'listing-health': { properties: ['productId'], required: ['productId'] },
  'product-analytics': { properties: ['productId', 'days'], required: ['productId'] },
  'channel-stock-drift': { properties: ['productId', 'limit'], required: [] },
  'replenishment-forecast': { properties: ['productId'], required: ['productId'] },
  'insights-metric': { properties: ['days'], required: [] },
  'detect-anomalies': { properties: ['limit'], required: [] },
  'draft-alt-text': { properties: ['productId'], required: ['productId'] },
  'draft-listing-content': { properties: ['productId'], required: ['productId'] },
  'draft-seo': { properties: ['productId'], required: ['productId'] },
  'translate-content': { properties: ['productId', 'target'], required: ['productId', 'target'] },
  'draft-customer-message': { properties: ['intent', 'orderId'], required: ['intent'] },
  'set-price': { properties: ['productId', 'price'], required: ['productId', 'price'] },
  'publish-listing': { properties: ['productId', 'channel'], required: ['productId', 'channel'] },
  'send-customer-message': { properties: ['orderId', 'message'], required: ['orderId', 'message'] },
}

const OWNER: UserPrincipal = {
  kind: 'user',
  userId: 'u1',
  label: 'Owner',
  permissions: { isOwner: true, permissions: new Set() },
  via: 'app',
}

describe('MCP.3 — every tool describes its own arguments', () => {
  it('every schema is an object schema whose required keys it defines', () => {
    const bad: string[] = []
    for (const tool of listTools()) {
      const schema = inputJsonSchema(tool) as JsonObjectSchema
      const properties = Object.keys(schema.properties ?? {})
      if (schema.type !== 'object') bad.push(`${tool.name}: not an object`)
      if ('$schema' in schema) bad.push(`${tool.name}: carries $schema`)
      for (const key of schema.required ?? []) {
        if (!properties.includes(key)) bad.push(`${tool.name}: requires undefined ${key}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('keeps every argument the old hand-written map promised', () => {
    for (const [name, promised] of Object.entries(PROMISED)) {
      const tool = listTools().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      const schema = inputJsonSchema(tool!) as JsonObjectSchema
      expect({ name, properties: Object.keys(schema.properties ?? {}).sort() }).toEqual({
        name,
        properties: [...promised.properties].sort(),
      })
      expect({ name, required: [...(schema.required ?? [])].sort() }).toEqual({
        name,
        required: [...promised.required].sort(),
      })
    }
  })

  it('the four tools the old map missed are described now', () => {
    const described = (name: string) =>
      Object.keys((inputJsonSchema(listTools().find((t) => t.name === name)!) as JsonObjectSchema).properties ?? {})
    expect(described('apply-content')).toEqual(['productId', 'title', 'bulletPoints', 'description'])
    expect(described('create-negative-keyword')).toContain('keywordText')
    expect(described('graduate-keyword')).toContain('sourceExternalCampaignId')
    expect(described('set-target-bid')).toEqual(['targetId', 'proposedBidCents'])
  })

  it('the model is offered every tool the person may use, each with its generated schema', () => {
    const offered = anthropicTools(OWNER)
    expect(offered.map((t) => t.name).sort()).toEqual(listTools().map((t) => t.name).sort())
    for (const tool of offered) expect(tool.input_schema).toBe(inputJsonSchema(listTools().find((t) => t.name === tool.name)!))
  })
})

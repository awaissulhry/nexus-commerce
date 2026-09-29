/**
 * MCP.7 — how every registered tool is described to Claude, computed from the tool itself.
 *
 * The integration test (routes/mcp.routes.vitest.test.ts) checks the wire; this one holds the
 * rules for the whole registry, so a new tool is covered the day it is added.
 */
import { describe, expect, it } from 'vitest'
import { listTools } from '../agents/tool-registry.js'
import { offeredOn } from '../agents/call-tool.js'
import { requiredScope, toolAnnotations } from './mcp-server.js'

/** Call OUR AI provider: offered in the app only. */
const AI_DRAFTS = ['draft-alt-text', 'draft-customer-message', 'draft-listing-content', 'draft-seo', 'translate-content']
/** Their preview or their action reaches a marketplace or a buyer. */
const OPEN_WORLD = ['publish-listing', 'send-customer-message', 'set-price']

describe('MCP.7 — every tool, as Claude sees it', () => {
  it('has a short title', () => {
    const bad = listTools().filter((tool) => !tool.title?.trim() || tool.title.length > 40).map((tool) => tool.name)
    expect(bad).toEqual([])
  })

  it('a read is readOnly and needs nexus.read; anything else is destructive and needs nexus.write', () => {
    for (const tool of listTools()) {
      const hints = toolAnnotations(tool)
      expect({ name: tool.name, title: hints.title, readOnlyHint: hints.readOnlyHint }).toEqual({
        name: tool.name,
        title: tool.title,
        readOnlyHint: tool.readOnly,
      })
      expect({ name: tool.name, scope: requiredScope(tool) }).toEqual({
        name: tool.name,
        scope: tool.readOnly ? 'nexus.read' : 'nexus.write',
      })
      if (!tool.readOnly || tool.alwaysAsk || tool.riskTier === 'high') {
        expect({ name: tool.name, destructiveHint: hints.destructiveHint }).toEqual({ name: tool.name, destructiveHint: true })
      }
    }
  })

  it('open world exactly where a marketplace or a buyer is reached', () => {
    const open = listTools().filter((tool) => toolAnnotations(tool).openWorldHint).map((tool) => tool.name).sort()
    expect(open).toEqual(OPEN_WORLD)
  })

  it('the AI drafts, and only they, are kept from Claude', () => {
    const appOnly = listTools().filter((tool) => !offeredOn(tool, 'mcp')).map((tool) => tool.name).sort()
    expect(appOnly).toEqual(AI_DRAFTS)
    expect(listTools().every((tool) => offeredOn(tool, 'app'))).toBe(true)
  })
})

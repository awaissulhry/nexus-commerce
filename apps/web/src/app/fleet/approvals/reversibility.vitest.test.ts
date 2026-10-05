/**
 * What stays of the old Approvals page's tests after clean-up F (2026-10-05): the assertions about code that is still
 * live. `reversibility.ts` and the fleet tool cards (`DecisionCard.tsx` TOOL_CARDS) still serve the Fleet Overview's
 * ads inbox (`ApprovalInbox.tsx`, rendered by FleetTab), which this clean-up leaves untouched (PLAN §9).
 * Ported from approvals-words.vitest.test.ts (C1, MCP.12).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_CARDS } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { reversibilityFrom } from './reversibility'

describe('C1 — how far a change can be undone comes from the API row, not from a copy on the page', () => {
  it('the row’s own word is kept', () => {
    expect(reversibilityFrom('full')).toBe('full')
    expect(reversibilityFrom('partial')).toBe('partial')
    expect(reversibilityFrom('none')).toBe('none')
  })

  it('a row that says nothing (an older API, an unknown tool) is treated as irreversible', () => {
    expect(reversibilityFrom(undefined)).toBe('none')
    expect(reversibilityFrom(null)).toBe('none')
    expect(reversibilityFrom('yes')).toBe('none')
  })

  it('no tool card states reversibility any more', () => {
    for (const vocab of Object.values(TOOL_CARDS)) expect(vocab).not.toHaveProperty('undoable')
  })
})

describe('MCP.12 — the ads inbox names no one channel', () => {
  it('its parked row says nothing has changed yet', () => {
    const inbox = readFileSync(join(import.meta.dirname, '../../marketing/ads/rules-automation/fleet/ApprovalInbox.tsx'), 'utf8')
    expect(inbox).not.toContain('Nothing has reached Amazon yet')
    expect(inbox).toContain('Nothing has changed yet.')
  })
})

/**
 * Editing correctness (group 3 review) — the Ad Manager's Bulk Actions send a campaign's budget as its own write: a budget
 * refused because it moved since no longer takes the status or bidding strategy sent with it down too, and the line says
 * per campaign which part was not changed. Made-up names.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkApplyMessage } from './bulkCampaignWrites'

const grid = readFileSync(join(__dirname, '..', 'CampaignsGrid.tsx'), 'utf8')
const refused = 'Changed since: now €25.00 (the screen showed €20.00). Nothing was written, so the newer value stands.'

describe('a bulk change, part by part', () => {
  it('a pause with a budget that moved since: the pause applies, the budget is named as not changed', () => {
    expect(bulkApplyMessage([
      { name: 'Camp A', parts: [{ part: 'status', wrote: true }, { part: 'budget', wrote: false, reason: refused }] },
      { name: 'Camp B', parts: [{ part: 'status', wrote: true }, { part: 'budget', wrote: true }] },
    ])).toBe(`Applied to 1 campaign · 1 campaign partly changed — Camp A: budget — ${refused}`)
  })
  it('nothing of a campaign written: "not changed", with its first part\'s reason', () => {
    expect(bulkApplyMessage([
      { name: 'Camp A', parts: [{ part: 'status', wrote: false, reason: 'Refused.' }] },
      { name: 'Camp C', parts: [{ part: 'status', wrote: false, reason: 'Refused.' }] },
    ])).toBe('Applied to 0 campaigns · 2 campaigns not changed — Camp A: status — Refused. (and 1 more)')
  })
  it('the grid sends the budget apart from the status / strategy, one after the other', () => {
    expect(grid).toMatch(/campaignParts\.push\(\{ part: ch\.status && ch\.strategy \? 'status and bidding strategy'/)
    expect(grid).toMatch(/campaignParts\.push\(\{ part: 'budget'/)
    expect(grid).toContain('for (const p of campaignParts) out.push(await run(p))')
    expect(grid).toContain('setApplyMsg(bulkApplyMessage(outcomes))')
  })
})

describe('an Undo or a rollback some rows of which changed since says so (the answer\'s reason)', () => {
  const ads = join(__dirname, '..', '..')
  const src = (file: string) => readFileSync(join(ads, file), 'utf8')
  it('the keyword tracker\'s Undo, the Suggestions Undo, the bulk-sheet rollback, the rule run rollback', () => {
    expect(src('rules-automation/keyword-tracker/ChangeLog.tsx')).toContain("${b.changedSince && b.reason ? ` ${b.reason}` : ''}")
    const suggestions = src('suggestions/SuggestionsClient.tsx')
    expect(suggestions).toContain('} else if (r.ok && (j?.reversed ?? 0) > 0 && j?.changedSince) {')
    expect(src('bulk/BulkClient.tsx')).toContain('toast(body.changedSince || body.failed')
    expect(src('rules-automation/tabs/RuleListTab.tsx')).toContain("{done.changedSince && done.reason ? ` · ${done.reason}` : ''}")
    expect(src('rules-automation/bid/rules/ruleApi.ts')).toContain("${b.changedSince && b.reason ? ` · ${b.reason}` : ''}")
  })
  it('a Suggestions Undo that left part of its set is not marked undone (its Undo stays)', () => {
    const suggestions = src('suggestions/SuggestionsClient.tsx')
    const partial = suggestions.slice(suggestions.indexOf('j?.changedSince) {'), suggestions.indexOf('} else if (r.ok && j?.ok !== false'))
    expect(partial).not.toContain('rolledBack: true')
  })
  it('re-review (c) — the A.I. Bids queue Undo too: a partial set is not "Change undone" and not marked undone', () => {
    const suggestions = src('suggestions/SuggestionsClient.tsx')
    const ai = suggestions.slice(suggestions.indexOf('const aiDoUndo'), suggestions.indexOf('const applyAiStaged'))
    const partial = ai.slice(ai.indexOf('j?.changedSince) {'), ai.indexOf('} else if (r.ok && j?.ok !== false'))
    expect(partial).toContain("toast(`${j.reversed} change${j.reversed === 1 ? '' : 's'} undone. ${j.reason ?? ''}`.trim(), 'warning')")
    expect(partial).not.toContain('rolledBack: true')
  })
})

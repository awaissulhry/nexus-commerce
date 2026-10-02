/**
 * MCP full control C9 — Settings › AI › Claude says what the API decides, in plain words: which choice raises what
 * Claude may do (and so asks for a fresh 2FA code), the limits as a person reads and types them, and each activity
 * outcome. Pure logic: the components render it.
 */
import { describe, expect, it } from 'vitest'
import {
  changeWords,
  connectionWords,
  levelLabel,
  limitFields,
  limitsSummary,
  OUTCOME_LABEL,
  OUTCOMES,
  parseLimits,
  pauseSentence,
  raises,
  raiseText,
  tightens,
  toolReach,
  type ActivityRow,
  type ClaudeRule,
  type LimitsSchema,
} from './claudeWords'

const PRICE_SCHEMA: LimitsSchema = {
  type: 'object',
  properties: { maxChangePercent: { type: 'number', description: 'the most the master price may move, up or down, in percent of the current price', exclusiveMinimum: 0, maximum: 100, default: 10 } },
}

describe('levels', () => {
  it('raising lets Claude do more and asks for the code; lowering and staying do not', () => {
    expect(raises('ask', 'auto')).toBe(true)
    expect(raises('off', 'ask')).toBe(true)
    expect(raises('auto', 'ask')).toBe(false)
    expect(raises('ask', 'ask')).toBe(false)
    expect(raises('confirm', 'off')).toBe(false)
  })

  it('a read is offered or not; a change names who decides', () => {
    expect(levelLabel('ask', true)).toBe('On — Claude may use it')
    expect(levelLabel('off', true)).toBe('Off — not offered to Claude')
    expect(levelLabel('auto', false)).toBe('Auto — runs by your rule, inside its limits')
    expect(levelLabel('confirm', false)).toContain('authenticator code in Claude')
  })

  it('what a tool reaches, and when it cannot be undone', () => {
    expect(toolReach({ readOnly: true, openWorld: false, reversibility: null })).toBe('Reads')
    expect(toolReach({ readOnly: false, openWorld: true, reversibility: 'full' })).toBe('Changes; reaches a marketplace or a buyer')
    expect(toolReach({ readOnly: false, openWorld: true, reversibility: 'none' })).toBe('Changes; reaches a marketplace or a buyer; cannot be undone')
    expect(toolReach({ readOnly: false, openWorld: false, reversibility: 'full' })).toBe('Changes in Nexus')
  })
})

describe('limits', () => {
  it('the schema becomes fields: a sentence, bounds and the current value', () => {
    expect(limitFields(PRICE_SCHEMA, { maxChangePercent: 10 })).toEqual([
      { key: 'maxChangePercent', label: 'The most the master price may move, up or down, in percent of the current price', min: 0, max: 100, value: '10', integer: false },
    ])
    expect(limitFields(null, null)).toEqual([])
  })

  it('one line for the grid; a read has none; limits that no longer fit say so', () => {
    expect(limitsSummary({ readOnly: false, limits: { maxChangePercent: 10 }, limitsSchema: PRICE_SCHEMA })).toBe('10 · the most the master price may move, up or down, in percent of the current price')
    expect(limitsSummary({ readOnly: true, limits: null, limitsSchema: null })).toBe('—')
    expect(limitsSummary({ readOnly: false, limits: null, limitsSchema: PRICE_SCHEMA, limitsInvalid: 'x' })).toContain('set them again')
  })

  it('tightening is a brake (sent at once); anything else loosens (asks for the code)', () => {
    const fields = limitFields({ properties: { maxProducts: { type: 'integer' }, minMargin: { type: 'number' }, maxChangePercent: { type: 'number' } } }, { maxProducts: 25, minMargin: 5, maxChangePercent: 10 })
    expect(tightens(fields, { maxProducts: 10, minMargin: 8, maxChangePercent: 10 })).toBe(true)
    expect(tightens(fields, { maxProducts: 25, minMargin: 5, maxChangePercent: 10 })).toBe(true)
    expect(tightens(fields, { maxProducts: 30, minMargin: 5, maxChangePercent: 10 })).toBe(false)
    expect(tightens(fields, { maxProducts: 10, minMargin: 4, maxChangePercent: 10 })).toBe(false)
    expect(tightens(fields, null)).toBe(false) // back to the defaults: the API decides; the page asks for the code
  })

  it('typed values are numbers inside their bounds, or the first problem in words', () => {
    const fields = limitFields(PRICE_SCHEMA, { maxChangePercent: 10 })
    expect(parseLimits(fields, { maxChangePercent: '12,5' })).toEqual({ limits: { maxChangePercent: 12.5 } })
    expect(parseLimits(fields, {})).toEqual({ limits: { maxChangePercent: 10 } })
    expect(parseLimits(fields, { maxChangePercent: '150' })).toEqual({ error: expect.stringContaining('at most 100') })
    expect(parseLimits(fields, { maxChangePercent: 'lots' })).toEqual({ error: expect.stringContaining('type a number') })
  })
})

describe('the brakes', () => {
  it('running: how many ran by rule against the cap; paused: who, why, and what happens now', () => {
    const base = { pausedAt: null, pausedBy: null, reason: null, dailyAutoCap: 200, autoRunsLastDay: 3 }
    expect(pauseSentence({ ...base, paused: false })).toBe('Changes set to Auto run by your rule. 3 of at most 200 ran in the last 24 hours.')
    expect(pauseSentence({ ...base, paused: true, pausedBy: 'Nexus', reason: '5 changes run by rule were stale or failed within an hour' }))
      .toBe('Nexus paused them itself: 5 changes run by rule were stale or failed within an hour. Every change Claude asks for waits for a person until they are resumed.')
    expect(pauseSentence({ ...base, paused: true, pausedBy: 'Ada' })).toMatch(/^Ada paused them\. /)
  })
})

describe('activity', () => {
  const row = (extra: Partial<ActivityRow>): ActivityRow => ({
    runId: 'r1', at: new Date().toISOString(), who: { userId: 'u1', name: 'Ada' }, connection: { id: 'grant_123456789', app: null }, tool: 'set-price', outcome: 'auto', ...extra,
  })

  it('every outcome has words', () => {
    for (const outcome of OUTCOMES) expect(OUTCOME_LABEL[outcome]).toBeTruthy()
  })

  it('what became of the change, and whether it can be put back', () => {
    expect(changeWords(row({ change: { id: 'c1', reversibility: 'full', undo: 'possible', outbound: true } }))).toBe('Can be undone (sent to the marketplace again)')
    expect(changeWords(row({ change: { id: 'c1', reversibility: 'full', undo: 'waiting', outbound: false } }))).toBe('An undo waits for a person')
    expect(changeWords(row({ change: { id: 'c1', reversibility: 'none', undo: 'not possible', outbound: true } }))).toBe('Cannot be undone')
    expect(changeWords(row({ plan: { steps: 3, byStatus: { done: 2, skipped: 1 } } }))).toBe('Plan of 3: 2 ran, 1 did not')
    expect(changeWords(row({ outcome: 'refused', note: 'Product not found' }))).toBe('Product not found')
  })

  it('a connection by its app, else the start of its id', () => {
    expect(connectionWords(row({ connection: { id: 'grant_123456789', app: 'Claude' } }))).toBe('Claude')
    expect(connectionWords(row({}))).toBe('Connection grant_12')
  })
})

describe('the 2FA dialog says what it raises, once (2026-10-02 end-to-end run: "Set Set product tags to Confirm")', () => {
  const rule = { name: 'set-product-tags', title: 'Set product tags' } as ClaudeRule

  it('a tool is named as a name, never glued to a verb of its own', () => {
    expect(raiseText({ kind: 'level', rule, level: 'confirm' }).title).toBe('Raise “Set product tags” to Confirm')
    expect(raiseText({ kind: 'level', rule, level: 'auto' }).sentence).toContain('“Set product tags” changes by your rule')
    expect(raiseText({ kind: 'limits', rule, limits: { maxTags: 30 } }).title).toBe('Change the limits for “Set product tags”')
  })

  it('no title or sentence repeats a word back to back, whatever the tool is called', () => {
    const titles = ['Set product tags', 'Set price', 'Change listing title', 'Confirm change', 'Raise bids']
    for (const title of titles) {
      const r = { name: 'x', title } as ClaudeRule
      for (const raise of [
        { kind: 'level' as const, rule: r, level: 'confirm' as const },
        { kind: 'level' as const, rule: r, level: 'auto' as const },
        { kind: 'limits' as const, rule: r, limits: null },
      ]) {
        const text = raiseText(raise)
        for (const line of [text.title, text.sentence]) expect(line).not.toMatch(/\b(\w+)\s+\1\b/i)
      }
    }
    expect(raiseText({ kind: 'cap', value: 40 }).title).toBe('Raise the daily limit')
    expect(raiseText({ kind: 'resume' }).title).toBe('Resume changes that run by rule')
  })
})

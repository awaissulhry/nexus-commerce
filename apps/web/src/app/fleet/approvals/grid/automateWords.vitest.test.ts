/**
 * Approvals grid — "Automate this kind…" (PLAN.md §4): the words and rules of the modal, and the modal built on the design
 * system only. The rule itself is the settings page's (claudeWords.ts); these pin what the modal adds on top of it:
 *   which levels a kind may take · why a kind always needs a person · the hint from the request · when Save asks for the
 *   2FA code · the history test in words · "Also approve this one" never ticked for the person.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { QueueRow, RuleSimulation } from '@nexus/shared/approval-queue'
import type { ClaudeRule } from '@/app/settings/ai/claude/claudeWords'
import {
  alwaysNeedsYouWords,
  ceilingNote,
  exampleWords,
  fieldErrors,
  fixedLimits,
  levelChoices,
  mayAlsoApprove,
  modalTitle,
  leadSentence,
  numberLimits,
  PLAN_TOOL,
  requestHint,
  rowOffersChoices,
  saveLabel,
  savePlan,
  serverErrorField,
  simulatePath,
  simulationWords,
  testLimits,
  valueNumber,
} from './automateWords'

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'ap_1',
  toolName: 'set-price',
  title: 'Set price',
  area: 'pricing',
  state: 'waiting',
  rawStatus: 'pending',
  note: null,
  target: { kind: 'product', id: 'p1', sku: 'XR-GLOVE-M', name: 'Gale glove', count: 1, href: null },
  channel: null,
  market: null,
  changes: [{ label: 'Price', from: '€49.90', to: '€44.91' }],
  changeCount: 1,
  summary: null,
  asker: { kind: 'claude', label: 'Claude · Awais', person: 'Awais', connection: null },
  decider: null,
  reversibility: 'full',
  reachesOutside: false,
  requestedAt: '2026-10-05T10:00:00Z',
  expiresAt: null,
  executeAfter: null,
  decidedAt: null,
  plan: null,
  canApprove: true,
  cannotApproveWhy: null,
  bulkApprovable: true,
  bulkBlockedWhy: null,
  automation: { level: 'ask', max: 'auto', whyWaits: 'Your rule for Set price: Ask me' },
  ...over,
})

const SET_PRICE: ClaudeRule = {
  name: 'set-price',
  title: 'Set price',
  category: 'pricing',
  readOnly: false,
  openWorld: false,
  reversibility: 'full',
  ceiling: 'auto',
  levels: ['off', 'ask', 'confirm', 'auto'],
  level: 'ask',
  stored: 'ask',
  limits: { maxChangePercent: 10 },
  defaultLimits: { maxChangePercent: 10 },
  limitsSchema: {
    type: 'object',
    properties: { maxChangePercent: { type: 'number', description: 'the most the price may move, in percent', exclusiveMinimum: 0, maximum: 100 } },
  },
}
const rule = (over: Partial<ClaudeRule> = {}): ClaudeRule => ({ ...SET_PRICE, ...over })

describe('the levels a kind may take', () => {
  it('only the levels under both ceilings, the row\'s and the rule\'s; Off stays on the settings page', () => {
    expect(levelChoices(rule(), 'auto')).toEqual(['ask', 'confirm', 'auto'])
    expect(levelChoices(rule(), 'confirm')).toEqual(['ask', 'confirm'])
    expect(levelChoices(rule({ ceiling: 'confirm', levels: ['off', 'ask', 'confirm'] }), 'auto')).toEqual(['ask', 'confirm'])
    // Ask only = nothing to choose.
    expect(levelChoices(rule({ ceiling: 'ask', levels: ['off', 'ask'] }), 'auto')).toEqual([])
    expect(levelChoices(rule(), 'ask')).toEqual([])
  })

  it('a plan or a kind capped at Ask offers nothing, and says why in the API\'s words or the reversibility', () => {
    expect(rowOffersChoices(row())).toBe(true)
    expect(rowOffersChoices(row({ automation: { level: 'ask', max: 'ask', whyWaits: null } }))).toBe(false)
    expect(rowOffersChoices(row({ automation: { level: 'off', max: 'off', whyWaits: null } }))).toBe(false)
    expect(rowOffersChoices(row({ toolName: PLAN_TOOL, automation: { level: 'auto', max: 'auto', whyWaits: null } }))).toBe(false)

    const capped = { level: 'ask', max: 'ask' } as const
    expect(alwaysNeedsYouWords(row({ automation: { ...capped, whyWaits: 'This kind always needs you: it cannot be undone' } })))
      .toBe('This kind always needs you: it cannot be undone.')
    expect(alwaysNeedsYouWords(row({ reversibility: 'none', automation: { ...capped, whyWaits: null } }))).toBe('This kind always needs you: it cannot be undone.')
    expect(alwaysNeedsYouWords(row({ reachesOutside: true, automation: { ...capped, whyWaits: null } })))
      .toBe('This kind always needs you: it reaches a marketplace or a buyer.')
    // A sentence about something else (a fleet agent's request) is not used as the reason.
    expect(alwaysNeedsYouWords(row({ automation: { ...capped, whyWaits: 'Rules apply only to Claude’s requests: …' } }))).toBe('This kind always needs you.')
    expect(alwaysNeedsYouWords(row({ toolName: PLAN_TOOL }))).toMatch(/^A change plan runs by itself only when every kind of step in it may\./)
  })

  it('a kind that stops at Confirm says it never runs by itself', () => {
    expect(ceilingNote(['ask', 'confirm'])).toBe('This kind can go as far as Confirm in Claude: it never runs by itself.')
    expect(ceilingNote(['ask', 'confirm', 'auto'])).toBeNull()
  })

  it('the title and the lead name the kind as a name, so a verb title never runs into the sentence', () => {
    expect(modalTitle(row())).toBe('Automate “Set price”')
    expect(leadSentence(row())).toBe('From now on, “Set price” requests from Claude:')
  })
})

describe('"Also approve this one"', () => {
  it('only for a request that waits for a person this viewer may approve', () => {
    expect(mayAlsoApprove(row())).toBe(true)
    expect(mayAlsoApprove(row({ state: 'back_to_you' }))).toBe(true)
    expect(mayAlsoApprove(row({ state: 'failed' }))).toBe(false)
    expect(mayAlsoApprove(row({ state: 'starting' }))).toBe(false)
    expect(mayAlsoApprove(row({ canApprove: false }))).toBe(false)
  })

  it('is never ticked for the person: the modal starts it unticked', () => {
    const source = readFileSync(join(import.meta.dirname, 'AutomateModal.tsx'), 'utf8')
    expect(source).toMatch(/const \[alsoApprove, setAlsoApprove\] = useState\(false\)/)
    expect(source).toMatch(/alsoApprove: approvable && alsoApprove/)
  })
})

describe('limits', () => {
  it('the number limits are the settings page\'s fields; switches and lists are shown, not edited', () => {
    expect(numberLimits(rule()).map((f) => [f.key, f.value])).toEqual([['maxChangePercent', '10']])
    const schema = {
      type: 'object',
      properties: {
        maxTagChanges: { type: 'integer', description: 'the most tags', maximum: 50 },
        allowNewTags: { type: 'boolean', description: 'whether a new tag may be made' },
        areas: { type: 'array', description: 'the areas Claude may stop' },
      },
    }
    expect(fixedLimits(schema, { maxTagChanges: 5, allowNewTags: false, areas: ['ads', 'pricing'] })).toEqual([
      { key: 'allowNewTags', label: 'Whether a new tag may be made', value: 'No' },
      { key: 'areas', label: 'The areas Claude may stop', value: 'ads, pricing' },
    ])
    expect(fixedLimits(schema, { areas: [] })[1].value).toBe('None')
  })

  it('reads the number in a change\'s value, in any currency or sign', () => {
    expect(valueNumber('€49.90')).toBe(49.9)
    expect(valueNumber('−€5.00')).toBe(-5)
    expect(valueNumber('SEK 120.00')).toBe(120)
    expect(valueNumber('3')).toBe(3)
    expect(valueNumber('Paused')).toBeNull()
    expect(valueNumber(null)).toBeNull()
  })

  it('hints what this request shows, and only when the row makes it obvious', () => {
    const percent = { key: 'maxChangePercent' }
    expect(requestHint(percent, row())).toBe('This request: −10%')
    expect(requestHint(percent, row({ changes: [{ label: 'Price', from: '€40.00', to: '€44.00' }] }))).toBe('This request: 10%')
    expect(requestHint(percent, row({
      changes: [{ label: 'A', from: '€10.00', to: '€11.00' }, { label: 'B', from: '€10.00', to: '€8.80' }],
      changeCount: 2,
    }))).toBe('This request: up to 12%')
    // Not every change line is in the row: no hint rather than a partial one.
    expect(requestHint(percent, row({ changeCount: 40 }))).toBeNull()
    expect(requestHint(percent, row({ changes: [{ label: 'Status', from: null, to: 'Paused' }] }))).toBeNull()
    expect(requestHint({ key: 'maxChangePct' }, row())).toBe('This request: −10%')
    // A count only when the request names that many of the limit's own kind.
    const many = row({ target: { kind: 'product', id: null, sku: 'A', name: null, count: 12, href: null } })
    expect(requestHint({ key: 'maxProducts' }, many)).toBe('This request: 12 products')
    expect(requestHint({ key: 'maxListings' }, many)).toBeNull()
    expect(requestHint({ key: 'maxTagChanges' }, many)).toBeNull()
  })

  it('says what is wrong with a typed limit beside it; the API\'s refusal sits beside the limit it names', () => {
    const fields = numberLimits(rule())
    expect(fieldErrors(fields, { maxChangePercent: '' })).toEqual({ maxChangePercent: 'Type a number.' })
    expect(fieldErrors(fields, { maxChangePercent: '120' })).toEqual({ maxChangePercent: 'At most 100.' })
    expect(fieldErrors(fields, { maxChangePercent: '7,5' })).toEqual({})
    expect(serverErrorField('Limits for set-price: maxChangePercent — Too big: expected number to be <=100.', fields)).toBe('maxChangePercent')
    expect(serverErrorField('days must be a whole number from 1 to 90.', fields)).toBeNull()
  })
})

describe('Save — when it asks for the 2FA code (as the settings page does)', () => {
  it('raising the level asks for the code; the limits go only when they changed', () => {
    expect(savePlan(rule(), 'auto', {})).toMatchObject({ kind: 'save', patch: { level: 'auto' }, needsCode: true, raise: { kind: 'level', level: 'auto' } })
    expect(savePlan(rule(), 'confirm', { maxChangePercent: 'x' })).toMatchObject({ kind: 'save', patch: { level: 'confirm' }, needsCode: true })
    const both = savePlan(rule(), 'auto', { maxChangePercent: '5' })
    expect(both).toMatchObject({ kind: 'save', patch: { level: 'auto', limits: { maxChangePercent: 5 } }, needsCode: true, raise: { kind: 'level' } })
  })

  it('lowering, and only tightening, save at once with no code', () => {
    const auto = rule({ level: 'auto', stored: 'auto' })
    expect(savePlan(auto, 'ask', { maxChangePercent: '50' })).toEqual({ kind: 'save', patch: { level: 'ask' }, needsCode: false, raise: { kind: 'level', rule: auto, level: 'ask' } })
    expect(savePlan(auto, 'auto', { maxChangePercent: '5' })).toMatchObject({ kind: 'save', patch: { limits: { maxChangePercent: 5 } }, needsCode: false })
    expect(savePlan(auto, 'auto', { maxChangePercent: '10' })).toEqual({ kind: 'nothing' })
  })

  it('loosening a limit asks for the code; a bad limit saves nothing', () => {
    const auto = rule({ level: 'auto', stored: 'auto' })
    expect(savePlan(auto, 'auto', { maxChangePercent: '20' })).toMatchObject({ kind: 'save', patch: { limits: { maxChangePercent: 20 } }, needsCode: true, raise: { kind: 'limits' } })
    expect(savePlan(auto, 'auto', { maxChangePercent: '200' })).toEqual({ kind: 'invalid', errors: { maxChangePercent: 'At most 100.' } })
  })

  it('limits saved that no longer fit the kind are set again, with no code when they do not loosen', () => {
    const broken = rule({ level: 'auto', stored: 'auto', limitsInvalid: 'maxChangePercent: Too big' })
    expect(savePlan(broken, 'auto', {})).toMatchObject({ kind: 'save', patch: { limits: { maxChangePercent: 10 } }, needsCode: false })
  })

  it('the button says what pressing it does', () => {
    expect(saveLabel({ kind: 'nothing' }, true)).toBe('Approve this one')
    const plan = savePlan(rule(), 'auto', {})
    expect(saveLabel(plan, false)).toBe('Save')
    expect(saveLabel(plan, true)).toBe('Save and approve this one')
  })
})

describe('the history test', () => {
  it('asks the API about Auto with the typed limits, over 30 days', () => {
    const path = simulatePath('set-price', testLimits(rule(), { maxChangePercent: '7,5' }))
    const [base, query] = path.split('?')
    expect(base).toBe('/api/claude/trust/set-price/simulate')
    const params = new URLSearchParams(query)
    expect(params.get('days')).toBe('30')
    expect(params.get('level')).toBe('auto')
    expect(JSON.parse(params.get('limits')!)).toEqual({ maxChangePercent: 7.5 })
    expect(new URLSearchParams(simulatePath('set-price', null).split('?')[1]).has('limits')).toBe(false)
    expect(testLimits(rule(), { maxChangePercent: '' })).toBeNull()
  })

  const sim = (over: Partial<RuleSimulation>): RuleSimulation => ({
    toolName: 'set-price', days: 30, considered: 40, wouldRun: 34, rejectedAmongWouldRun: 2, examples: [], ...over,
  })

  it('says it in words, including what should make the person think', () => {
    expect(simulationWords(sim({}), row())).toEqual({
      headline: 'With these limits, 34 of your last 40 “Set price” requests would have run by themselves.',
      rejected: 'You rejected 2 of those.',
    })
    expect(simulationWords(sim({ rejectedAmongWouldRun: 0 }), row()).rejected).toBe('You rejected none of those.')
    expect(simulationWords(sim({ wouldRun: 0, rejectedAmongWouldRun: 0 }), row()).rejected).toBeNull()
    expect(simulationWords(sim({ considered: 0, wouldRun: 0, rejectedAmongWouldRun: 0 }), row())).toEqual({
      headline: 'No “Set price” requests in the last 30 days to test against.',
      rejected: null,
    })
    expect(simulationWords(sim({ considered: 1, wouldRun: 1, rejectedAmongWouldRun: 1 }), row())).toEqual({
      headline: 'With these limits, your one “Set price” request of the last 30 days would have run by itself.',
      rejected: 'You rejected it.',
    })
    expect(simulationWords(sim({ considered: 1, wouldRun: 0, rejectedAmongWouldRun: 0 }), row()).headline).toMatch(/would not have run by itself\.$/)
  })

  it('each rejected example keeps the person\'s own reason', () => {
    expect(exampleWords({ id: 'a', summary: 'XR-GLOVE-M €49.90 → €39.90', rejectedReason: 'too low' })).toEqual({
      what: 'XR-GLOVE-M €49.90 → €39.90',
      why: 'Your reason: “too low”',
    })
    expect(exampleWords({ id: 'b', summary: '', rejectedReason: null })).toEqual({ what: 'A request with no summary', why: 'You gave no reason.' })
  })
})

describe('built on the design system', () => {
  const HERE = import.meta.dirname
  const modal = readFileSync(join(HERE, 'AutomateModal.tsx'), 'utf8')
  const css = readFileSync(join(HERE, 'automate.css'), 'utf8')

  it('DS controls only, no Tailwind, only its own layout classes; light like the fleet pages', () => {
    expect(modal).not.toMatch(/<(button|input|select|table|textarea)[\s>]/)
    expect(modal).not.toMatch(/components\/ui/)
    for (const [, classes] of modal.matchAll(/className="([^"]*)"/g)) {
      expect(classes.split(/\s+/).every((c) => /^aq-auto(-[a-z]+)*$/.test(c)), classes).toBe(true)
    }
    expect(modal).toMatch(/const PORTAL = 'fleet-portal'/)
    expect(modal.match(/className=\{PORTAL\}/g)).toHaveLength(2) // the modal and its 2FA dialog
    expect(modal).toMatch(/import Link from '@\/lib\/workspaces\/Link'/)
    expect(modal).toMatch(/<Link href="\/settings\/ai\/claude"/)
  })

  it('saves through the settings page\'s own call and its own 2FA dialog', () => {
    expect(modal).toMatch(/claudeApi\.setRule\(rule\.name, plan\.patch\)/)
    expect(modal).toMatch(/claudeApi\.setRule\(rule\.name, \{ \.\.\.pending\.patch, code \}\)/)
    expect(modal).toMatch(/<StepUpModal/)
    expect(modal).toMatch(/err\.code === 'mfa_required'/)
  })

  it('the stylesheet holds layout only, on the design tokens', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/font-size:\s*\d/)
    expect(css).not.toMatch(/var\(--(?!nds-)/)
    for (const [, selector] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
      expect(selector.trim(), selector).toMatch(/^\.aq-auto/)
    }
  })
})

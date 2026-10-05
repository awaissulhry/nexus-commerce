/**
 * Approvals grid — the drawer's words (build agent D2, 2026-10-05). Pure: status, timeline, the channel's answer,
 * why it waits, the verbs per state, the change lines, and the edit-spec table for "edit, then approve".
 */
import { describe, expect, it } from 'vitest'
import { QUEUE_STATES, type QueueDetail, type QueueRow } from '@nexus/shared/approval-queue'
import {
  EDIT_SPECS, askAgainHint, askerSaysLabel, changesView, channelResultView, consequenceWords, drawerVerbs, editPatch, editPlan,
  eventWords, parseEditInput, parseMoneyText, planProgress, requestArgsOf, shortId, statusWords, targetWords, timelineSteps, whereLine, whyView,
  type EditField,
} from './drawerWords'
import * as drawerWords from './drawerWords'
import { STATE_META } from './queueWords'

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'appr_0123456789abcdef',
  toolName: 'set-price',
  title: 'Set master price',
  area: 'pricing',
  state: 'waiting',
  rawStatus: 'pending',
  note: null,
  target: { kind: 'product', id: 'p1', sku: 'TEST-GLOVE-M', name: 'Test glove M', count: 1, href: '/products/p1/edit' },
  channel: null,
  market: null,
  changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }],
  changeCount: 1,
  summary: null,
  asker: { kind: 'claude', label: 'Claude · Test', person: 'Test Person', connection: 'Claude Desktop' },
  decider: null,
  reversibility: 'full',
  reachesOutside: true,
  nexusRecord: false,
  requestedAt: '2026-10-05T08:00:00.000Z',
  expiresAt: '2026-10-06T08:00:00.000Z',
  executeAfter: null,
  decidedAt: null,
  plan: null,
  canApprove: true,
  cannotApproveWhy: null,
  bulkApprovable: true,
  bulkBlockedWhy: null,
  automation: { level: 'ask', max: 'auto', whyWaits: 'Your rule for Set master price: Ask me' },
  ...over,
})

const detail = (over: Partial<QueueDetail> = {}): QueueDetail => ({
  ...row(),
  allChanges: [{ label: 'Base price', from: '€50.00', to: '€52.00' }],
  items: [],
  editArgs: null,
  askerReason: null,
  operatorNote: null,
  reason: null,
  timeline: [{ at: '2026-10-05T08:00:00.000Z', kind: 'asked', words: 'Claude · Test asked' }],
  channelResult: null,
  change: null,
  canEdit: true,
  ...over,
})

const formOf = (d: QueueDetail, args: Record<string, unknown> | null = null): EditField => {
  const plan = editPlan(d, args)
  if (plan?.kind !== 'form') throw new Error(`expected a form, got ${JSON.stringify(plan)}`)
  return plan.field
}

describe('status: one set of words for the whole life of a request', () => {
  it('names every state the API can send in the grid’s own words and tones (queueWords STATE_META), with no copy', () => {
    for (const state of QUEUE_STATES) {
      expect(STATE_META[state]?.label, state).toBeTruthy()
      expect(['neutral', 'info', 'success', 'warning', 'danger']).toContain(STATE_META[state].tone)
      // A single request that has not finished: the drawer's pill is exactly the grid's.
      if (state !== 'done') expect(statusWords(row({ state })), state).toEqual(STATE_META[state])
    }
    expect(statusWords(row({ state: 'failed' })).tone).toBe('danger')
    expect(statusWords(row({ state: 'back_to_you' })).tone).toBe('warning')
    expect(drawerWords).not.toHaveProperty('STATE_WORDS')
    expect(drawerWords).not.toHaveProperty('PENDING_STATES')
  })

  it('a running plan says how far it got', () => {
    expect(statusWords(row({ state: 'running', plan: { steps: 120, byStatus: { done: 34, pending: 86 } } })).label).toBe('Running · 34 of 120')
  })

  it('a finished change says only what Nexus knows about the channel', () => {
    const done = row({ state: 'done', channel: 'EBAY', market: 'IT' })
    expect(statusWords(done, { state: 'reached', words: 'Sent.' })).toEqual({ label: 'Done · reached eBay IT', tone: 'success' })
    expect(statusWords(done, { state: 'unknown', words: '…' }).label).toBe('Done in Nexus')
    expect(statusWords(done, { state: 'failed', words: '…' })).toEqual({ label: 'Done in Nexus · eBay IT did not take it', tone: 'warning' })
    expect(statusWords(done, null).label).toBe('Done')
  })

  it('where, what it means, and the product', () => {
    expect(whereLine(row({ channel: 'AMAZON', market: 'DE' }))).toBe('Amazon DE')
    expect(whereLine(row({ reachesOutside: false }))).toBe('In Nexus only')
    expect(whereLine(row())).toBe('Not named in the request')
    // A master price is made in Nexus, even though the listings that follow it are sent on.
    expect(whereLine(row({ nexusRecord: true }))).toBe('Nexus')
    expect(consequenceWords(row())).toBe('Reaches a marketplace or a buyer; can be undone')
    expect(consequenceWords(row({ reachesOutside: false, reversibility: 'none' }))).toBe('Stays in Nexus; cannot be undone')
    expect(targetWords(row().target)).toEqual({ main: 'TEST-GLOVE-M', name: 'Test glove M', more: null, href: '/products/p1/edit' })
    expect(targetWords({ kind: 'product', id: null, sku: 'A', name: null, count: 12, href: null })?.more).toBe('and 11 more')
    expect(targetWords(null)).toBeNull()
  })

  it('plan progress counts done, skipped and failed steps', () => {
    expect(planProgress({ steps: 120, byStatus: { done: 34, skipped: 2, failed: 1, pending: 83 } })).toEqual({
      done: 34, value: 37, max: 120, words: '34 of 120 steps done · 2 skipped, 1 failed',
    })
  })
})

describe('why, the timeline and the channel’s answer', () => {
  it('a failed or handed-back request says why, prominently', () => {
    expect(whyView(detail({ state: 'failed', note: 'Execution failed: price below floor' }))).toMatchObject({ banner: true, tone: 'danger', text: 'Execution failed: price below floor' })
    expect(whyView(detail({ state: 'back_to_you', note: null, reason: 'not run — the price moved' }))).toMatchObject({ banner: true, tone: 'warning', text: 'not run — the price moved' })
    expect(whyView(detail({ state: 'failed', note: null }))?.text).toBe('Nexus did not record why.')
    expect(whyView(detail())).toMatchObject({ banner: false, title: 'Why it waits for you', text: 'Your rule for Set master price: Ask me' })
    expect(whyView(detail({ state: 'done', note: null }))).toBeNull()
    // A running plan's step count is its progress bar's: not said twice.
    expect(whyView({ ...detail({ state: 'running', note: '2 of 6 steps done' }), plan: { steps: 6, byStatus: { done: 2 } } })).toBeNull()
    expect(whyView(detail({ state: 'running', note: 'Running' }))).toMatchObject({ title: 'Result', text: 'Running' })
  })

  it('an event the API sent without words gets plain ones; a reason becomes the detail', () => {
    expect(eventWords({ kind: 'failed', words: '' })).toEqual({ label: 'The run failed', detail: null })
    expect(eventWords({ kind: 'handed_back', words: 'not run — stale' })).toEqual({ label: 'Handed back to you', detail: 'not run — stale' })
    expect(eventWords({ kind: 'approved', words: 'Approved by Test' })).toEqual({ label: 'Approved by Test', detail: null })
    expect(eventWords({ kind: 'ran', words: '  ' }).label).toBe('Ran')
  })

  it('an unknown channel answer always says Nexus cannot see it, never a success', () => {
    const unknown = channelResultView({ state: 'unknown', words: 'Approved: it was published through the Nexus studio. publication-status reads its result.' })
    expect(unknown.title).toBe('Nexus cannot see the channel’s answer')
    expect(unknown.tone).not.toBe('success')
    expect(unknown.detail).toContain('publication-status')
    expect(channelResultView({ state: 'unknown', words: 'Nexus cannot see the channel’s answer for this kind of change.' }).detail).toBeNull()
    expect(channelResultView({ state: 'reached', words: 'Amazon: 1 sent.' })).toEqual({ title: 'Reached the channel', tone: 'success', detail: 'Amazon: 1 sent.' })
    expect(channelResultView({ state: 'failed', words: 'refused' }).tone).toBe('danger')
  })

  it('the timeline: the events, what is still to come, then the channel’s answer', () => {
    const steps = timelineSteps(detail({
      state: 'done',
      timeline: [
        { at: '2026-10-05T08:00:00.000Z', kind: 'asked', words: 'Claude · Test asked' },
        { at: '2026-10-05T08:05:00.000Z', kind: 'ran', words: 'Ran · approved by Test' },
      ],
      channelResult: { state: 'unknown', words: 'Nexus cannot see the channel’s answer for this kind of change.' },
    }))
    expect(steps.map((s) => s.label)).toEqual(['Claude · Test asked', 'Ran · approved by Test', 'Nexus cannot see the channel’s answer'])
    expect(steps[2]).not.toHaveProperty('at')
    const starting = timelineSteps(detail({ state: 'starting' }))
    expect(starting.at(-1)).toMatchObject({ key: 'runs', at: null })
  })

  it('the asker’s words get a label that names who said them', () => {
    expect(askerSaysLabel({ kind: 'claude', label: 'Claude · Test' })).toBe('Claude says')
    expect(askerSaysLabel({ kind: 'fleet', label: 'Ads director' })).toBe('Ads director says')
  })
})

describe('the verbs are the grid row’s, per state', () => {
  it('waiting and handed back: approve and reject; failed: retry and reject; starting: undo and hold', () => {
    expect(drawerVerbs('waiting')).toMatchObject({ approve: true, reject: true, retry: null })
    expect(drawerVerbs('failed')).toMatchObject({ approve: false, reject: true, retry: 'Retry' })
    expect(drawerVerbs('back_to_you')).toMatchObject({ approve: true, retry: null, reject: true })
    expect(drawerVerbs('starting')).toMatchObject({ undo: true, hold: true, approve: false })
    expect(drawerVerbs('on_hold')).toMatchObject({ undo: true, hold: false })
    for (const state of ['running', 'done', 'rejected', 'expired', 'replaced', 'recorded'] as const) {
      expect(Object.values(drawerVerbs(state)).some(Boolean), state).toBe(false)
    }
  })

  it('the id is shortened on screen only', () => {
    expect(shortId('appr_0123456789abcdef')).toBe('appr_0…cdef')
    expect(shortId('short')).toBe('short')
  })
})

describe('the changes: every line, or the items of a bulk request', () => {
  it('lines, with how many more the request covers', () => {
    const view = changesView(detail({ changeCount: 3 }))
    expect(view).toMatchObject({ mode: 'lines', more: 2 })
  })

  it('a bulk request over several products lists its items, then "and N more"', () => {
    const items = [
      { sku: 'A', name: 'Alpha', change: { label: 'Base price', from: '€1.00', to: '€2.00' } },
      { sku: 'B', name: null, change: { label: 'Base price', from: '€1.00', to: '€2.00' } },
    ]
    expect(changesView(detail({ items, changeCount: 120 }))).toMatchObject({ mode: 'items', more: 118 })
    // One product with many fields (a publish) keeps its lines.
    expect(changesView(detail({ items: items.map((i) => ({ ...i, sku: 'A' })), changeCount: 2 })).mode).toBe('lines')
  })
})

describe('edit, then approve: the edit-spec table', () => {
  it('no edit unless the API says it may be edited and nobody decided yet', () => {
    expect(editPlan(detail({ canEdit: false }), null)).toBeNull()
    expect(editPlan(detail({ state: 'starting' }), null)).toBeNull()
  })

  it('a tool without an unambiguous value says to ask for a new request', () => {
    expect(editPlan(detail({ toolName: 'publish-listing' }), null)).toEqual({ kind: 'ask', hint: 'To change it, ask Claude for a new request.' })
    expect(askAgainHint({ kind: 'fleet' })).toBe('To change it, reject it and ask for a new request.')
  })

  it('set-price: the master price, typed in euros, sent in euros, started from the change line', () => {
    const field = formOf(detail())
    expect(field).toMatchObject({ currency: '€', initial: '52.00', proposed: '€52.00' })
    expect(field.spec.arg).toBe('price')
    expect(parseEditInput(field, '48.5')).toEqual({ ok: true, value: 48.5 })
    expect(parseEditInput(field, '48,50')).toEqual({ ok: true, value: 48.5 })
    expect(parseEditInput(field, '0')).toMatchObject({ ok: false, error: 'Use more than €0.00.' })
    expect(parseEditInput(field, '48.555')).toMatchObject({ ok: false, error: 'Use at most 2 decimals.' })
    expect(parseEditInput(field, '1,234.50')).toMatchObject({ ok: false })
    expect(parseEditInput(field, '52')).toMatchObject({ ok: false, error: 'That is the value the request already has.' })
    expect(editPatch(field, 48.5, null)).toEqual({ price: 48.5 })
  })

  it('set-target-bid: typed in the campaign currency, sent in cents, within the old card’s bounds', () => {
    const field = formOf(detail({ toolName: 'set-target-bid', allChanges: [{ label: 'Bid', from: '€0.50', to: '€0.45' }] }))
    expect(field.initial).toBe('0.45')
    expect(parseEditInput(field, '0.40')).toEqual({ ok: true, value: 40 })
    expect(parseEditInput(field, '0.04')).toMatchObject({ ok: false, error: 'Use at least €0.05.' })
    expect(parseEditInput(field, '42')).toMatchObject({ ok: false, error: 'Use at most €10.00.' })
    expect(editPatch(field, 40, null)).toEqual({ proposedBidCents: 40 })
  })

  it('graduate-keyword: the starting bid is read from "“term” at €0.45"', () => {
    const field = formOf(detail({ toolName: 'graduate-keyword', allChanges: [{ label: 'New exact keyword', from: null, to: '“race gloves” at SEK 4.50' }] }))
    expect(field).toMatchObject({ currency: 'SEK', initial: '4.50' })
    expect(editPatch(field, 400, null)).toEqual({ bidCents: 400 })
  })

  it('the Matrix and own-warehouse stock need the request’s arguments; without them, ask again', () => {
    expect(editPlan(detail({ toolName: 'set-listing-price' }), null)?.kind).toBe('ask')
    expect(editPlan(detail({ toolName: 'set-listing-price' }), { action: 'adjust-prices', percent: 5 })?.kind).toBe('ask')
    const price = formOf(detail({ toolName: 'set-listing-price' }), { action: 'set-price', price: 99.75, productId: 'p1' })
    expect(price).toMatchObject({ initial: '99.75' })
    expect(editPatch(price, 95, null)).toEqual({ price: 95 })

    const pin = formOf(detail({ toolName: 'set-listing-stock' }), { action: 'pin-quantity', quantity: 10 })
    expect(pin.spec.arg).toBe('quantity')
    expect(parseEditInput(pin, '2.5')).toMatchObject({ ok: false, error: 'Use a whole number.' })
    expect(editPlan(detail({ toolName: 'set-listing-stock' }), { action: 'push-now' })?.kind).toBe('ask')

    const item = { productId: 'p1', location: 'IT-MAIN', quantity: 3 }
    const stock = formOf(detail({ toolName: 'set-stock' }), { items: [item], reason: 'MANUAL_ADJUSTMENT' })
    expect(stock.initial).toBe('3')
    expect(editPatch(stock, 5, { items: [item] })).toEqual({ items: [{ ...item, quantity: 5 }] })
    expect(editPlan(detail({ toolName: 'set-stock' }), { items: [item, { ...item, productId: 'p2' }] })?.kind).toBe('ask')
  })

  it('text: a review reply holds 2–80 characters', () => {
    const field = formOf(detail({ toolName: 'reply-to-review' }), { body: 'Thank you!', reviewId: 'r1' })
    expect(field.initial).toBe('Thank you!')
    expect(parseEditInput(field, 'x')).toMatchObject({ ok: false, error: 'Write at least 2 characters.' })
    expect(parseEditInput(field, 'y'.repeat(81))).toMatchObject({ ok: false })
    expect(parseEditInput(field, 'Thanks a lot')).toEqual({ ok: true, value: 'Thanks a lot' })
  })

  it('every entry names the argument the server patches', () => {
    for (const [tool, entry] of Object.entries(EDIT_SPECS)) {
      if ('needsArgs' in entry) continue
      expect(entry.arg, tool).toMatch(/^[a-zA-Z]+$/)
      expect(entry.label, tool).toBeTruthy()
    }
  })

  it('the request’s arguments are read only from an `editArgs` object', () => {
    expect(requestArgsOf(detail())).toBeNull()
    expect(requestArgsOf({ ...detail(), editArgs: { price: 1 } })).toEqual({ price: 1 })
    expect(requestArgsOf({ ...detail(), editArgs: [1] })).toBeNull()
  })

  it('money text is parsed only when it is unambiguous', () => {
    expect(parseMoneyText('€49.90')).toEqual({ amount: 49.9, currency: '€' })
    expect(parseMoneyText('SEK 120.00')).toEqual({ amount: 120, currency: 'SEK' })
    expect(parseMoneyText('49.90')).toEqual({ amount: 49.9, currency: null })
    expect(parseMoneyText('−€5.00')).toEqual({ amount: -5, currency: '€' })
    expect(parseMoneyText('€1,234.00')).toBeNull()
    expect(parseMoneyText('(empty)')).toBeNull()
    expect(parseMoneyText(null)).toBeNull()
  })
})

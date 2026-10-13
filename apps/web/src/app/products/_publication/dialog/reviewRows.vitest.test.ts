import { describe, expect, it } from 'vitest'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'

import type { ActionPlanRow } from './actionPlan'
import { fieldStatus, fieldTick, fieldValues, marketStateRow, reviewCounts, reviewTableRows, valueText, type ReviewTableMarket } from './reviewRows'

const planRow = (over: Partial<ActionPlanRow> & Pick<ActionPlanRow, 'key' | 'productId' | 'sku'>): ActionPlanRow => ({
  kind: 'content', what: { column: 'send', mode: 'partial', setAt: null, setByName: null }, action: null, sent: '', warning: null,
  checkedAtSend: null, notSent: null, setBy: null, stale: false, tick: 'on', tickable: true, danger: false, changeIds: [],
  defaultFieldIds: [], fields: { ticked: 0, total: 0 }, creates: null, notListed: false, ...over,
})

const change = (over: Partial<StudioPublishChange> & Pick<StudioPublishChange, 'id' | 'productId'>): StudioPublishChange => ({
  sku: 'GALE-M', field: 'title', label: 'Title', current: { state: 'value', value: 'New title' }, lastAccepted: { state: 'value', value: 'Old title' },
  channel: { state: 'value', value: 'Old title' }, status: 'SEND', localChanged: true, channelChanged: false, selectable: true, selectedByDefault: true,
  reason: '', operation: 'replace', ...over,
})

const partial = planRow({ key: 'content:p1', productId: 'p1', sku: 'GALE-M', tick: 'some', fields: { ticked: 1, total: 2 } })
const full = planRow({ key: 'content:p2', productId: 'p2', sku: 'GALE-L', what: { column: 'send', mode: 'full', setAt: null, setByName: null }, tick: 'on', fields: { ticked: 3, total: 3 } })
const del = planRow({ key: 'life:1', productId: 'p3', sku: 'GALE-S', kind: 'lifecycle', action: 'delete', danger: true, what: { column: 'send', mode: 'delete', setAt: null, setByName: null }, tick: 'on' })
const held = planRow({ key: 'held:p4', productId: 'p4', sku: 'GALE-XL', kind: 'held', notSent: 'Not listed', tick: 'none', tickable: false })

const it_: ReviewTableMarket = {
  key: 'amazon-it', label: 'Amazon · IT',
  rows: [del, full, partial, held],
  review: {
    id: 'r1', photosOnly: false,
    issues: [{ severity: 'error', sku: 'GALE-XS', message: 'GALE-XS: Bullet 1 is too long' }, { severity: 'warning', message: 'A note' }],
    changes: [
      change({ id: 'p1:title', productId: 'p1' }),
      change({ id: 'p1:price', productId: 'p1', field: 'price', label: 'Price', status: 'DIFFERS', current: { state: 'value', value: 149 }, channel: { state: 'value', value: 129 } }),
      change({ id: 'p1:brand', productId: 'p1', field: 'brand', label: 'Brand', status: 'SAME' }),
      change({ id: 'p2:title', productId: 'p2', locked: true }),
    ],
    removals: [{ productId: 'p2', sku: 'GALE-L', field: 'bullets', label: 'Bullet 5', value: 'x'.repeat(300) }],
  },
  selectedIds: ['p1:title', 'p2:title'],
  lifecycleIds: ['life:1'],
}
const de: ReviewTableMarket = { key: 'amazon-de', label: 'Amazon · DE', rows: [], review: null, selectedIds: [], lifecycleIds: [], state: { tone: 'danger', text: 'The review could not complete', action: 'check' } }

describe('the Publish review, one row per change', () => {
  it('lists the problems first, then each product with its own fields and what a Full update removes', () => {
    const rows = reviewTableRows([it_])
    expect(rows.map(r => r.type)).toEqual(['problem', 'plan', 'plan', 'field', 'removal', 'plan', 'field', 'field', 'plan'])
    const problem = rows[0]
    expect(problem.type === 'problem' && problem.message).toBe('Bullet 1 is too long')
    // A field the channel already holds as Nexus does is not a row.
    expect(rows.filter(r => r.type === 'field').map(r => r.type === 'field' && r.change.id)).toEqual(['p2:title', 'p1:title', 'p1:price'])
  })

  it('shows a value the channel loses WHOLE — never cut at 120 characters', () => {
    const removal = reviewTableRows([it_]).find(r => r.type === 'removal')
    expect(removal?.type === 'removal' && removal.value).toBe('x'.repeat(300))
  })

  it('a market with nothing to list yet is one row that says why', () => {
    const rows = reviewTableRows([it_, de])
    const state = rows.find(r => r.type === 'state')
    expect(state?.type === 'state' && state.market.label).toBe('Amazon · DE')
    expect(state?.type === 'state' && state.state.action).toBe('check')
  })

  it('filters: Problems keeps the problems and the rows that send nothing; Deletes keeps what deletes', () => {
    expect(reviewTableRows([it_, de], 'problems').map(r => `${r.type}:${'row' in r ? r.row.sku : ''}`))
      .toEqual(['problem:', 'plan:GALE-XL', 'state:'])
    expect(reviewTableRows([it_], 'deletes').map(r => `${r.type}:${'row' in r ? r.row.sku : ''}`))
      .toEqual(['plan:GALE-S', 'plan:GALE-L', 'removal:GALE-L'])
  })
})

describe('the summary strip', () => {
  it('counts the markets, the listings that send, the changes, the problems and the deletes', () => {
    expect(reviewCounts([it_, de])).toEqual({ markets: 1, listings: 3, changes: 1 + 1 + 1, problems: 1, deletes: 1 + 1 })
  })
})

describe('a field\'s tick and words', () => {
  it('a Partial row\'s field ticks on its own; a Full update\'s fields follow the row', () => {
    const [title] = it_.review!.changes!
    expect(fieldTick(partial, title, { selectedIds: ['p1:title'], locked: false, reviewId: 'r1' })).toEqual({ on: true, enabled: true })
    expect(fieldTick(partial, title, { selectedIds: [], locked: true, reviewId: 'r1' })).toEqual({ on: false, enabled: false })
    expect(fieldTick(full, it_.review!.changes![3], { selectedIds: [], locked: false, reviewId: 'r1' })).toEqual({ on: true, enabled: false })
  })

  it('only photos can be ticked while other fields have problems', () => {
    const [title] = it_.review!.changes!
    expect(fieldTick(partial, title, { selectedIds: [], locked: false, reviewId: 'r1', photosOnly: true }).enabled).toBe(false)
  })

  it('reads Channel now → Nexus sends, and an offer draft in its own words', () => {
    expect(fieldValues(it_.review!.changes![1])).toEqual({ now: '129', sends: '149' })
    expect(fieldValues(change({ id: 'x', productId: 'p1', display: { current: '€99.00', lastAccepted: '€109.00', channel: '€119.00' } }))).toEqual({ now: '€119.00', sends: '€99.00' })
    expect(fieldValues(change({ id: 'y', productId: 'p1', operation: 'delete' })).sends).toBe('Removed')
    expect(fieldStatus({ status: 'DIFFERS' })).toEqual({ label: 'Differs on channel', tone: 'warning' })
  })
})

describe('a value in words', () => {
  it('never shows raw JSON: a list one item per line, an object one key per line', () => {
    expect(valueText({ state: 'value', value: ['Breathable mesh', 'CE level 2'] })).toBe('• Breathable mesh\n• CE level 2')
    expect(valueText({ state: 'value', value: { unit: 'cm', value: 40 } })).toBe('unit: cm\nvalue: 40')
    expect(valueText({ state: 'value', value: [{ language: 'it', value: 'Giacca' }] })).toBe('• language: it; value: Giacca')
    expect(valueText({ state: 'absent' })).toBe('Not set')
    expect(valueText({ state: 'unknown', reason: 'Amazon did not answer' })).toBe('Unknown — Amazon did not answer')
    expect(valueText({ state: 'value', value: '' })).toBe('(empty text)')
    expect(valueText({ state: 'value', value: null })).toBe('Empty')
  })
})

describe('a market\'s row in All markets', () => {
  it('says why a market lists nothing yet, and offers what helps', () => {
    expect(marketStateRow({ kind: 'checking' })).toMatchObject({ tone: 'info' })
    expect(marketStateRow({ kind: 'checking' })?.action).toBeUndefined()
    expect(marketStateRow({ kind: 'error', message: 'Amazon did not answer' })).toEqual({ tone: 'danger', text: 'Could not check: Amazon did not answer', action: 'check' })
    expect(marketStateRow({ kind: 'expired' })?.action).toBe('check')
    expect(marketStateRow({ kind: 'input', needs: 'location' })?.action).toBe('open')
    expect(marketStateRow({ kind: 'blocked', problems: 0, reason: 'Skipped: no request', request: true })?.action).toBe('open')
    expect(marketStateRow({ kind: 'earlier', publicationId: 'p' })?.action).toBe('open')
  })
  it('stays out of the way when the market is ready, has nothing to send, or its problems are rows', () => {
    expect(marketStateRow({ kind: 'ready', changes: 3, whole: false, requestReady: true })).toBeNull()
    expect(marketStateRow({ kind: 'nothing', reason: 'none' })).toBeNull()
    expect(marketStateRow({ kind: 'blocked', problems: 2, reason: null })).toBeNull()
  })
})

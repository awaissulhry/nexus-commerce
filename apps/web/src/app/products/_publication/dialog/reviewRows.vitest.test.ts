import { describe, expect, it } from 'vitest'
import { blockedChanges, type StudioPublishChange } from '@nexus/shared/studio-publication'

import { publicationStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { ActionPlanRow } from './actionPlan'
import { problemGroups } from './model'
import {
  fieldNote, fieldStatus, fieldTick, fieldValues, lifecycleValues, marketStateRow, planRowTag, problemBanner, removalTag, reviewCounts, reviewPages, reviewTableRows,
  showInSheetTarget, valueText, type ReviewTableMarket, type ReviewTableRow,
} from './reviewRows'

const planRow = (over: Partial<ActionPlanRow> & Pick<ActionPlanRow, 'key' | 'productId' | 'sku'>): ActionPlanRow => ({
  kind: 'content', what: { column: 'send', mode: 'partial', setAt: null, setByName: null }, action: null, listingState: null, sent: '', warning: null,
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
const del = planRow({ key: 'life:1', productId: 'p3', sku: 'GALE-S', kind: 'lifecycle', action: 'delete', listingState: 'active', danger: true, what: { column: 'send', mode: 'delete', setAt: null, setByName: null }, tick: 'on' })
const held = planRow({ key: 'held:p4', productId: 'p4', sku: 'GALE-XL', kind: 'held', notSent: 'Not listed', tick: 'none', tickable: false })

const it_: ReviewTableMarket = {
  key: 'amazon-it', label: 'Amazon · IT',
  rows: [del, full, partial, held],
  review: {
    id: 'r1', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' },
    rows: [
      { productId: 'p1', sku: 'GALE-M', title: 'Jacket M', existing: true, mode: 'partial' },
      { productId: 'p2', sku: 'GALE-L', title: 'Jacket L', existing: true, mode: 'full' },
    ],
    issues: [{ severity: 'error', sku: 'GALE-XS', productId: 'p5', field: 'bullet_point', message: 'GALE-XS: Bullet 1 is too long' }, { severity: 'warning', message: 'A note' }],
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

  // Owner audit 2026-10-19 — the Problems filter listed Not listed and "No longer applies" rows; Deletes left Ends out of its count.
  it('filters: Problems lists only the problems to fix; Removes lists what a send removes', () => {
    expect(reviewTableRows([it_, de], 'problems').map(r => r.type)).toEqual(['problem'])
    const end = planRow({ key: 'life:2', productId: 'p6', sku: 'GALE-XXL', kind: 'lifecycle', action: 'end', listingState: 'active', danger: true,
      what: { column: 'status', target: 'ended', state: 'active', setAt: null, setByName: null }, tick: 'off' })
    expect(reviewTableRows([{ ...it_, rows: [...it_.rows, end] }], 'removes').map(r => `${r.type}:${'row' in r ? r.row.sku : ''}`))
      .toEqual(['plan:GALE-S', 'plan:GALE-L', 'removal:GALE-L', 'plan:GALE-XXL'])
    // The filter's number is what it lists that removes something, an unticked End included.
    expect(reviewCounts([{ ...it_, rows: [...it_.rows, end] }]).removesListed).toBe(3)
  })

  it('"All markets": one quiet row of notes per market — a warning is seen, never only in a closed fold', () => {
    const rows = reviewTableRows([it_, de], 'all', { notes: true })
    const notes = rows.filter(r => r.type === 'note')
    expect(notes).toHaveLength(1)
    expect(notes[0].type === 'note' && notes[0].notes).toEqual(['A note'])
    expect(rows.findIndex(r => r.type === 'note')).toBe(rows.findIndex(r => r.type === 'problem') + 1)
    expect(reviewTableRows([it_]).some(r => r.type === 'note')).toBe(false)
    expect(reviewTableRows([it_], 'problems', { notes: true }).some(r => r.type === 'note')).toBe(false)
  })
})

describe('the summary strip — the window\'s one count', () => {
  it('counts what goes as the summary line and the button do, problems as distinct problems on their SKUs', () => {
    // GALE-M: 1 ticked field; GALE-L (Full update): its 1 field, and the value it removes; GALE-S: a Delete.
    expect(reviewCounts([it_, de])).toEqual({ markets: 1, listings: 3, changes: 1 + 1, problems: 1, problemSkus: 1, removedListings: 1, removedValues: 1, removesListed: 2 })
  })
  it('the same words on several SKUs are one problem, on N SKUs, in every market', () => {
    const height = (sku: string) => ({ severity: 'error' as const, sku, message: `${sku}: Item package height is required.` })
    const many = { ...it_, review: { ...it_.review!, issues: [height('GALE-M'), height('GALE-L'), height('GALE-S')] } }
    expect(reviewCounts([many])).toMatchObject({ problems: 1, problemSkus: 3 })
    expect(reviewTableRows([many], 'problems')).toHaveLength(1)
  })
})

describe('a field\'s tick and words', () => {
  it('a Partial row\'s field ticks on its own; a Full update\'s fields follow the row', () => {
    const [title] = it_.review!.changes!
    expect(fieldTick(partial, title, { selectedIds: ['p1:title'], locked: false, reviewId: 'r1' })).toEqual({ on: true, enabled: true })
    expect(fieldTick(partial, title, { selectedIds: [], locked: true, reviewId: 'r1' })).toEqual({ on: false, enabled: false })
    expect(fieldTick(full, it_.review!.changes![3], { selectedIds: [], locked: false, reviewId: 'r1' })).toEqual({ on: true, enabled: false })
  })

  it('a change a problem leaves out is never on and cannot be ticked; it says "Left out: <problem>" (option A, Owner 2026-10-19)', () => {
    const [title] = it_.review!.changes!
    const problem = { productId: 'p1', field: 'title', severity: 'error' as const, message: 'Title: too long.' }
    const leftOut = blockedChanges({ ...it_.review!, issues: [problem] })
    expect([...leftOut.keys()]).toEqual(['p1:title'])
    expect(fieldTick(partial, title, { selectedIds: ['p1:title'], locked: false, reviewId: 'r1', leftOut })).toEqual({ on: false, enabled: false })
    expect(fieldNote(title, leftOut)).toBe('Left out: Title: too long.')
    // The row's other change still ticks.
    expect(fieldTick(partial, it_.review!.changes![1], { selectedIds: [], locked: false, reviewId: 'r1', leftOut }).enabled).toBe(true)
    expect(fieldNote(change({ id: 'z', productId: 'p1', reason: 'Nexus changed it.' }), leftOut)).toBe('Nexus changed it.')
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
    expect(marketStateRow({ kind: 'checking' })).toEqual({ tone: 'info', text: 'Checking… Reading the saved values and the channel.' })
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

describe('problems, one row per thing to fix', () => {
  it('groups the same problem on many SKUs into one row with every SKU, in order', () => {
    const groups = problemGroups([
      { severity: 'error', sku: 'GALE-M', message: 'GALE-M: Item package height is required.' },
      { severity: 'error', sku: 'GALE-L', message: 'GALE-L: Item package height is required.' },
      { severity: 'error', sku: 'GALE-L', message: 'GALE-L: Bullet 1 is too long', detail: 'Amazon: max 500' },
      { severity: 'error', sku: 'GALE-S', message: 'GALE-S: Item package height is required.' },
      { severity: 'warning', sku: 'GALE-S', message: 'A note, not a problem' },
    ])
    expect(groups.map(g => [g.message, g.skus])).toEqual([
      ['Item package height is required.', ['GALE-M', 'GALE-L', 'GALE-S']],
      ['Bullet 1 is too long', ['GALE-L']],
    ])
    expect(groups[1].detail).toBe('Amazon: max 500')
  })

  it('a problem on a kept change-only review says what it leaves out; one that names nothing holds back the content', () => {
    const left = { ...it_, review: { ...it_.review!, issues: [{ severity: 'error' as const, sku: 'GALE-M', productId: 'p1', field: 'title', message: 'GALE-M: Title is too long.' }] } }
    const problem = reviewTableRows([left]).find(r => r.type === 'problem')
    expect(problem?.type === 'problem' && problem.holds).toBe('Leaves out 1 change until it is fixed.')
    expect(problem?.type === 'problem' && [problem.productId, problem.field]).toEqual(['p1', 'title'])
    const elsewhere = reviewTableRows([it_]).find(r => r.type === 'problem')
    expect(elsewhere?.type === 'problem' && elsewhere.holds).toBe('Blocks nothing this publish sends.')
    const whole = { ...it_, review: { ...it_.review!, issues: [{ severity: 'error' as const, message: 'Reconnect this account.' }] } }
    const all = reviewTableRows([whole]).find(r => r.type === 'problem')
    expect(all?.type === 'problem' && all.holds).toBe('Holds back the content here until it is fixed.')
  })
})

describe('"Show in sheet" on a problem', () => {
  const problem = reviewTableRows([it_]).find((r): r is Extract<ReviewTableRow, { type: 'problem' }> => r.type === 'problem')!
  it('lands on the problem\'s product and field, only on the market the sheet shows', () => {
    expect(showInSheetTarget(problem, { inSheet: true })).toEqual({ productId: 'p5', field: 'bullet_point' })
    expect(showInSheetTarget(problem, { inSheet: false })).toBeNull()
    expect(showInSheetTarget(problem, undefined)).toBeNull()
  })
  it('is not offered for a problem that names no product', () => {
    expect(showInSheetTarget({ ...problem, productId: null, field: null }, { inSheet: true })).toBeNull()
  })
})

// Owner audit 2026-10-19 — "Sent" in green before anything was sent, and after the channel refused it.
describe('a row\'s word before and after the send', () => {
  it('says what WILL happen before the send', () => {
    expect(planRowTag(partial)).toEqual({ label: 'Will be sent', tone: 'info' })
    expect(planRowTag(del)).toEqual({ label: 'Will be deleted', tone: 'danger' })
    expect(planRowTag({ ...del, action: 'end' })).toEqual({ label: 'Will be ended', tone: 'danger' })
    expect(planRowTag(held)).toEqual({ label: 'Not sent', tone: 'neutral' })
    expect(planRowTag({ ...partial, tick: 'off' })).toEqual({ label: 'Unticked', tone: 'neutral' })
  })
  it('after the send, the real result — or "Not sent" for a row this send carried nothing for', () => {
    const failed = publicationStatusMeta('FAILED')
    const results = new Map([[partial.key, failed]])
    expect(planRowTag(partial, results)).toMatchObject({ label: 'Failed', tone: 'danger', meta: failed })
    expect(planRowTag(full, results)).toEqual({ label: 'Not sent', tone: 'neutral' })
    expect(planRowTag(held, results)).toEqual({ label: 'Not sent', tone: 'neutral' })
  })
  it('a value a Full update removes says "Will be removed" only while its row goes', () => {
    expect(removalTag(full)).toEqual({ label: 'Will be removed', tone: 'danger' })
    expect(removalTag({ ...full, tick: 'off' })).toEqual({ label: 'Stays', tone: 'neutral' })
  })
})

// Owner audit 2026-10-19 — a Delete showed nothing under "Channel now".
describe('a Delete\'s and a status change\'s Channel now', () => {
  it('reads "Active on Amazon · IT" → "Removed" for a Delete, → "Ended" for an End', () => {
    expect(lifecycleValues(del, 'Amazon · IT')).toEqual({ now: 'Active on Amazon · IT', sends: 'Removed' })
    const end = { ...del, action: 'end' as const, what: { column: 'status' as const, target: 'ended' as const, state: 'active' as const, setAt: null, setByName: null } }
    expect(lifecycleValues(end, 'eBay · IT')).toEqual({ now: 'Active on eBay · IT', sends: 'Ended' })
    const pause = { ...end, action: 'pause' as const, what: { ...end.what, target: 'inactive' as const } }
    expect(lifecycleValues(pause, 'eBay · IT')?.sends).toBe('Inactive')
    expect(lifecycleValues({ ...del, listingState: 'unknown' }, 'Amazon · IT')?.now).toBe('On Amazon · IT (its state was not read)')
    expect(lifecycleValues(partial, 'Amazon · IT')).toBeNull()
  })
})

// Owner audit 2026-10-19 — "Fix these before publishing" while ticked status changes could still go.
describe('the banner over the problems', () => {
  const base = { kept: true, namesNothing: false, leftOut: { changes: 0, problems: 0 }, statusChangesGo: false, inTable: true }
  it('says what still goes', () => {
    expect(problemBanner({ ...base, kept: false, statusChangesGo: true })).toEqual({ title: 'These hold back the content here',
      body: 'The status changes below can still be sent. Fix the problems, then check again to send the content.' })
    expect(problemBanner({ ...base, kept: false }).title).toBe('Fix these before publishing')
    expect(problemBanner({ ...base, namesNothing: true, statusChangesGo: true }).title).toBe('These hold back the content here')
    expect(problemBanner({ ...base, leftOut: { changes: 3, problems: 1 }, statusChangesGo: true })).toEqual({ title: '3 changes are left out by 1 problem',
      body: 'The other changes and the status changes can be sent now. Fix the problems, then check again to send the rest.' })
    expect(problemBanner(base).title).toBe('These problems block nothing this publish sends')
  })
})

describe('pages of about 100 rows', () => {
  const ref = { key: 'm', label: 'M' }
  const plan = (i: number): ReviewTableRow => ({ type: 'plan', key: `p${i}`, market: ref, row: planRow({ key: `content:${i}`, productId: `${i}`, sku: `S${i}` }) })
  const field = (i: number, j: number): ReviewTableRow => ({ type: 'field', key: `f${i}-${j}`, market: ref, row: planRow({ key: `content:${i}`, productId: `${i}`, sku: `S${i}` }), change: change({ id: `${i}:${j}`, productId: `${i}` }) })
  it('never splits a product from its own rows', () => {
    const rows: ReviewTableRow[] = []
    for (let i = 0; i < 30; i++) rows.push(plan(i), field(i, 1), field(i, 2), field(i, 3))
    const pages = reviewPages(rows, 10)
    expect(pages.every(p => p[0].type === 'plan')).toBe(true)
    expect(pages.flat()).toHaveLength(rows.length)
    expect(pages[0]).toHaveLength(8)
  })
  it('keeps a product larger than a page on one page of its own', () => {
    const rows = [plan(1), ...Array.from({ length: 12 }, (_, j) => field(1, j)), plan(2)]
    expect(reviewPages(rows, 10).map(p => p.length)).toEqual([13, 1])
  })
  it('is one page when it fits', () => {
    expect(reviewPages([plan(1)], 100)).toHaveLength(1)
    expect(reviewPages([], 100)).toEqual([])
  })
})

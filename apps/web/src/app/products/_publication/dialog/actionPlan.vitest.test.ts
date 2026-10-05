import { describe, expect, it } from 'vitest'
import { AMAZON_PAN_EU_DELETE_WARNING, deleteDoneSentence, fbaDeleteWarning } from '@nexus/shared/listing-actions'
import { relistSentence } from '@nexus/shared/publish-actions'
import { moveModeLabel, type StudioPublishReview, type StudioPublishScope } from '@nexus/shared/studio-publication'
import { ROLE_CANNOT_END_OR_DELETE, confirmMatches, type PublishPlanBatchChild, type PublishPlanDestination, type PublishPlanLifecycleRow } from '@nexus/shared/publish-plan'
import { EMPTY_ENTRY, destinationState, initialTicks, type DestinationEntry } from './destinations'
import { matchesPublishPlan } from './model'
import { NOT_LISTED_LEFT_OUT, NOT_LISTED_MAIN_HELD } from '@nexus/shared/listing-actions'
import {
  CHECK_ON_CHANNEL, CREATE_UNTICKED, EVERYTHING_SENT, NOTHING_HERE, NOT_SENT_PROBLEMS, RELIST_UNTICKED, actionPlanRows, actionPlanSend, agoText, confirmReason, confirmSentence, confirmWhat,
  createdCounts, createdWords, createsLine, planFamilySummary, reviewRowListingWord, shopifyVisibilityWords,
  lifecycleChildMeta, planButtonText, planResultRows, planResultWord, planSubmit, planSummaryLine, planTabWords, planUndo, roleLockSentence,
  setByText, toggleRowTicks, undoButtonText, undoSentence, withProductTicks, marketsSendingNothing, replacesCountWords,
} from './actionPlan'

const NOW = Date.parse('2026-10-04T10:00:00Z')
const MINUTES_AGO = (n: number) => new Date(NOW - n * 60_000).toISOString()
const LATER = '2026-10-04T10:15:00Z'
const IT: StudioPublishScope = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay' }
const DE: StudioPublishScope = { channel: 'EBAY', marketplace: 'DE', accountId: 'ebay' }

type Change = NonNullable<StudioPublishReview['changes']>[number]
const change = (productId: string, field: string, over: Partial<Change> = {}): Change => ({
  id: JSON.stringify([productId, field]), productId, sku: productId.toUpperCase(), field, label: field, status: 'SEND', selectable: true, selectedByDefault: true,
  reason: '', current: { state: 'value', value: 1 }, lastAccepted: { state: 'absent' }, channel: { state: 'value', value: 0 }, localChanged: true, channelChanged: false,
  operation: 'replace', ...over,
})

const review = (scope: StudioPublishScope, over: Partial<StudioPublishReview> = {}): StudioPublishReview => ({
  id: `r-${scope.marketplace}`, productId: 'gale', scope, accountLabel: 'Xavia', aliasLabel: 'Primary listing', mode: 'live', action: 'update',
  rows: [
    { productId: 'gale-s', sku: 'GALE-S', title: 'Jacket S', existing: true, mode: 'partial' },
    { productId: 'gale-m', sku: 'GALE-M', title: 'Jacket M', existing: true, mode: 'full' },
  ],
  excluded: 0, issues: [], expiresAt: LATER,
  changes: [
    change('gale-s', 'title'), change('gale-s', 'brand', { selectedByDefault: false, status: 'DIFFERS' }), change('gale-s', 'size', { selectable: false, selectedByDefault: false, status: 'SAME' }),
    change('gale-m', 'title', { locked: true }), change('gale-m', 'colour', { locked: true }),
  ],
  removals: [{ productId: 'gale-m', sku: 'GALE-M', field: 'material', label: 'Material', value: 'Leather' }],
  ...over,
})

const lifecycle = (id: string, action: PublishPlanLifecycleRow['action'], over: Partial<PublishPlanLifecycleRow> = {}): PublishPlanLifecycleRow => ({
  id, listingId: `l-${id}`, productId: `p-${id}`, sku: `GALE-${id.toUpperCase()}`, isParent: false,
  column: action === 'delete' ? 'send' : 'status', value: action === 'delete' ? 'delete' : action === 'pause' ? 'inactive' : action === 'end' ? 'ended' : 'active',
  action, step: action, state: action === 'resume' ? 'paused' : 'active', sentence: `${action} sentence`, consequence: `${action} consequence`, warning: null, checkedAtSend: null,
  setAt: MINUTES_AGO(5), setById: 'me', setByName: 'Awais', stale: false, tickedByDefault: true, needsTypedConfirm: action === 'end' || action === 'delete', refused: null,
  ...over,
})

const destination = (scope: StudioPublishScope, over: Partial<PublishPlanDestination> = {}): PublishPlanDestination => ({
  scope, destination: { channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: '' },
  label: `eBay · ${scope.marketplace}`, review: review(scope), fullProductIds: ['gale-m'], contentHeld: [], lifecycle: [], outgrown: [], error: null, ...over,
})

const entryOf = (plan: PublishPlanDestination, over: Partial<DestinationEntry> = {}): DestinationEntry => ({
  ...EMPTY_ENTRY, plan, review: plan.review, familySku: 'GALE-JACKET', canDelete: true,
  selectedIds: plan.review ? initialTicks(plan.review) : [], lifecycleIds: plan.lifecycle.filter(r => r.tickedByDefault && !r.refused).map(r => r.id), ...over,
})

const sendOf = (entries: Record<string, DestinationEntry>) =>
  actionPlanSend(Object.keys(entries), key => destinationState(entries[key], true, NOW), key => entries[key] ?? EMPTY_ENTRY)

describe('the one table of a market', () => {
  const plan = destination(IT, {
    lifecycle: [lifecycle('pause1', 'pause'), lifecycle('del1', 'delete'), lifecycle('end1', 'end'), lifecycle('res1', 'resume')],
    outgrown: [{ id: 'o1', listingId: 'l-o1', productId: 'p-o1', sku: 'GALE-XL', column: 'status', value: 'inactive', reason: 'Already inactive' }],
  })
  const rows = actionPlanRows(entryOf(plan), destinationState(entryOf(plan), true, NOW), NOW)

  it('puts danger rows first: Delete, End, then Inactive, Full update, Active, Partial; outgrown last', () => {
    expect(rows.map(r => r.key)).toEqual(['del1', 'end1', 'pause1', 'content:gale-m', 'res1', 'content:gale-s', 'outgrown:o1'])
    expect(rows.filter(r => r.danger).map(r => r.key)).toEqual(['del1', 'end1'])
  })
  it('a Partial row counts its ticked fields; its tick turns on the default fields only', () => {
    const partial = rows.find(r => r.key === 'content:gale-s')!
    expect(partial.sent).toBe('1 of 2 fields')
    expect(partial.tick).toBe('some')
    expect(partial.expandable).toBe(true)
    const off = toggleRowTicks(partial, false, { selectedIds: entryOf(plan).selectedIds, lifecycleIds: [] })
    expect(off.selectedIds.every(id => !id.includes('gale-s'))).toBe(true)
    expect(off.selectedIds.some(id => id.includes('gale-m'))).toBe(true)
    const on = toggleRowTicks(partial, true, off)
    expect(on.selectedIds).toContain(JSON.stringify(['gale-s', 'title']))
    expect(on.selectedIds).not.toContain(JSON.stringify(['gale-s', 'brand']))
  })
  it('a Partial row names how many of its ticked fields replace a channel value, in the channel\'s own name (Nexus wins)', () => {
    const replaces = { kind: 'channel_changed' as const, channel: '129.00', nexus: '149.00', sentence: 'Changed on eBay since the last publish. eBay has 129.00 — Publish sets 149.00.', note: null }
    const nexusWins = destination(IT, { review: review(IT, { changes: [change('gale-s', 'title'), change('gale-s', 'brand', { status: 'DIFFERS', replaces }),
      change('gale-s', 'price', { status: 'DIFFERS', replaces })] }) })
    const e = entryOf(nexusWins)
    const sent = (ids: string[]) => actionPlanRows({ ...e, selectedIds: ids }, destinationState({ ...e, selectedIds: ids }, true, NOW), NOW).find(r => r.key === 'content:gale-s')!.sent
    expect(sent(e.selectedIds)).toBe('3 of 3 fields · 2 replace eBay values')
    expect(sent(e.selectedIds.filter(id => !id.includes('price')))).toBe('2 of 3 fields · 1 replaces an eBay value')
    // "Keep eBay's values": the lines that replace are unticked, so nothing replaces.
    expect(sent([JSON.stringify(['gale-s', 'title'])])).toBe('1 of 3 fields')
    expect(replacesCountWords(1, 'AMAZON')).toBe('1 replaces an Amazon value')
    expect(replacesCountWords(1, 'SHOPIFY')).toBe('1 replaces a Shopify value')
    expect(replacesCountWords(1200, 'AMAZON')).toBe('1,200 replace Amazon values')
  })
  it('a Full row says everything is sent and lists what it removes', () => {
    const full = rows.find(r => r.key === 'content:gale-m')!
    expect(full.sent).toBe(EVERYTHING_SENT)
    expect(full.removals).toEqual([{ label: 'Material', value: 'Leather' }])
    expect(full.tick).toBe('on')
  })
  it('lifecycle rows carry the server sentence and who set them; outgrown rows say "No longer applies" and cannot be ticked', () => {
    const pause = rows.find(r => r.key === 'pause1')!
    expect(pause).toMatchObject({ sent: 'pause sentence', setBy: 'Set by Awais · 5 minutes ago', tick: 'on', tickable: true })
    const outgrown = rows.find(r => r.kind === 'outgrown')!
    expect(outgrown).toMatchObject({ notSent: 'No longer applies', tickable: false, sent: 'Already inactive. It is cleared when you publish.' })
  })
  it('a field tick inside one row keeps every other product\'s ticks', () => {
    const ids = withProductTicks(['a', 'b', 'c'], ['b', 'x'], ['x'])
    expect(ids.sort()).toEqual(['a', 'c', 'x'])
  })
  it('content behind problems is not sent; held rows the review does not list still show with their reason', () => {
    const blocked = destination(IT, { review: review(IT, { issues: [{ severity: 'error', message: 'Brand missing', productId: 'gale-s', sku: 'GALE-S', field: 'brand' } as never] }),
      contentHeld: [{ productId: 'gale-l', sku: 'GALE-L', reason: 'This listing is being deleted, so its changes are not sent.' }] })
    const e = entryOf(blocked)
    const out = actionPlanRows(e, destinationState(e, true, NOW), NOW)
    expect(out.find(r => r.key === 'content:gale-s')).toMatchObject({ notSent: NOT_SENT_PROBLEMS, tick: 'none', tickable: false })
    expect(out.find(r => r.key === 'held:gale-l')).toMatchObject({ kind: 'held', tick: 'none' })
  })
})

describe('default ticks: stale and refused values start unticked', () => {
  it('a stale row starts unticked and says who set it', () => {
    const stale = lifecycle('old', 'pause', { stale: true, tickedByDefault: false, setById: 'maria', setByName: 'Maria', setAt: MINUTES_AGO(2 * 24 * 60) })
    const plan = destination(IT, { lifecycle: [stale] })
    const row = actionPlanRows(entryOf(plan), { kind: 'ready', changes: 1, whole: false, requestReady: false }, NOW).find(r => r.key === 'old')!
    expect(row.tick).toBe('off')
    expect(row.setBy).toBe('Set by Maria · 2 days ago')
    expect(row.stale).toBe(true)
  })
  it('the relative time reads plainly', () => {
    expect(agoText(MINUTES_AGO(0), NOW)).toBe('just now')
    expect(agoText(MINUTES_AGO(1), NOW)).toBe('1 minute ago')
    expect(agoText(MINUTES_AGO(180), NOW)).toBe('3 hours ago')
    expect(agoText(null, NOW)).toBe('')
    expect(setByText({ setAt: null, setByName: null }, NOW)).toBe('Set by someone')
  })
})

describe('what one click sends', () => {
  it('counts the summary line from the ticks', () => {
    const plan = destination(IT, { lifecycle: [lifecycle('p1', 'pause'), lifecycle('p2', 'pause'), lifecycle('d1', 'delete'), lifecycle('e1', 'end')] })
    const send = sendOf({ it: entryOf(plan) })
    expect(send.counts).toMatchObject({ partial: 1, fields: 1, full: 1, inactive: 2, ended: 1, delete: 1 })
    expect(planSummaryLine(send.counts)).toBe('1 partial update (1 field) · 1 full update · 2 inactive · 1 ended · 1 delete')
    expect(planSummaryLine({ partial: 0, fields: 0, full: 0, delete: 0, active: 0, inactive: 0, ended: 0 })).toBe(NOTHING_HERE)
  })
  it('the counted button names End and Delete after the listings', () => {
    const counts = { partial: 18, fields: 41, full: 2, delete: 1, active: 1, inactive: 3, ended: 1 }
    const markets = { one: 'market', many: 'markets' }
    expect(planButtonText(counts, ['it'], markets)).toBe('Publish 24 listings · end 1 · delete 1')
    expect(planButtonText(counts, ['it', 'de'], markets, ['fr'])).toBe('Publish 24 listings to 2 markets · end 1 · delete 1 · skip 1 with problems')
    expect(planButtonText({ ...counts, partial: 0, full: 0, active: 0, inactive: 0 }, ['it'], markets)).toBe('End 1 listing · delete 1')
    expect(planButtonText({ partial: 0, fields: 0, full: 0, delete: 2, active: 0, inactive: 0, ended: 0 }, ['it'], markets)).toBe('Delete 2 listings')
  })
  it('"skip N with problems" counts only the markets that send nothing at all, for every caller (as the Publish window\'s line)', () => {
    const counts = { partial: 0, fields: 0, full: 0, delete: 0, active: 0, inactive: 2, ended: 0 }
    const markets = { one: 'market', many: 'markets' }
    // DE: content blocked, but its status change goes — published, not skipped. FR: skipped, sends nothing.
    expect(marketsSendingNothing(['de', 'fr'], ['it', 'de'])).toEqual(['fr'])
    expect(planButtonText(counts, ['it', 'de'], markets, ['de', 'fr'])).toBe('Publish 2 listings to 2 markets · skip 1 with problems')
    expect(planButtonText(counts, ['it', 'de'], markets, ['de'])).toBe('Publish 2 listings to 2 markets')
    expect(planButtonText({ ...counts, inactive: 0 }, [], markets, ['fr'])).toBe('Nothing to publish · 1 with problems')
    // The line above the tabs: the blocked market whose status changes go says "content blocked", not "with problems".
    expect(planFamilySummary(3, { skipped: ['de', 'fr'], nothing: [], pending: [] }, counts, 0, ['it', 'de']))
      .toBe('3 markets · 2 inactive · 1 with problems · 1 with content blocked')
    expect(planFamilySummary(2, { skipped: ['de'], nothing: [], pending: [] }, counts, 0, ['it', 'de'])).toBe('2 markets · 2 inactive · 1 with content blocked')
    expect(planFamilySummary(2, { skipped: ['de'], nothing: [], pending: [] }, counts, 0, ['it'])).toBe('2 markets · 2 inactive · 1 with problems')
  })
  it('asks for the typed family SKU only while an End or Delete row is ticked', () => {
    const plan = destination(IT, { lifecycle: [lifecycle('e1', 'end'), lifecycle('d1', 'delete'), lifecycle('p1', 'pause')] })
    const send = sendOf({ it: entryOf(plan) })
    expect(send.confirm).toEqual({ expected: 'GALE-JACKET', ended: 1, deleted: 1, places: ['eBay · IT'], skus: { ended: ['GALE-E1'], deleted: ['GALE-D1'] } })
    // S11 follow-up — the confirmation names the SKU each End and Delete acts on (the one the channel holds).
    expect(confirmSentence(send.confirm!)).toBe('Type GALE-JACKET to end GALE-E1 and delete GALE-D1 on eBay · IT')
    expect(confirmReason(send.confirm!)).toBe('Type GALE-JACKET below to end GALE-E1 and delete GALE-D1.')
    expect(confirmMatches(send.confirm!.expected, 'GALE-JACKE')).toBe(false)
    expect(confirmMatches(send.confirm!.expected, 'GALE-JACKET')).toBe(true)
    const withoutDanger = sendOf({ it: entryOf(plan, { lifecycleIds: ['p1'] }) })
    expect(withoutDanger.confirm).toBeNull()
  })
  it('without products.delete, End and Delete stay waiting and lock; the rest still sends', () => {
    const plan = destination(IT, { lifecycle: [
      lifecycle('e1', 'end', { refused: ROLE_CANNOT_END_OR_DELETE, tickedByDefault: false }),
      lifecycle('d1', 'delete', { refused: ROLE_CANNOT_END_OR_DELETE, tickedByDefault: false }),
      lifecycle('p1', 'pause'),
    ] })
    const entry = entryOf(plan, { canDelete: false })
    const send = sendOf({ it: entry })
    expect(send.roleLocked).toEqual({ ended: 1, deleted: 1 })
    expect(roleLockSentence(send.roleLocked)).toBe('1 end and 1 delete stay waiting: your role cannot end or delete listings.')
    expect(roleLockSentence({ ended: 1, deleted: 0 })).toBe('1 end stays waiting: your role cannot end or delete listings.')
    expect(send.confirm).toBeNull()
    expect(send.lifecycle).toEqual(['p1'])
    const locked = actionPlanRows(entry, destinationState(entry, true, NOW), NOW).filter(r => r.notSent === ROLE_CANNOT_END_OR_DELETE)
    expect(locked.map(r => [r.key, r.tickable, r.tick])).toEqual([['d1', false, 'none'], ['e1', false, 'none']])
    // A refused row the person somehow ticked is never sent.
    expect(sendOf({ it: { ...entry, lifecycleIds: ['e1', 'p1'] } }).lifecycle).toEqual(['p1'])
  })
  it('batch or today\'s direct submit', () => {
    const contentOnly = destination(IT)
    expect(sendOf({ it: entryOf(contentOnly) }).batch).toBe(false)
    expect(sendOf({ it: entryOf(contentOnly), de: entryOf(destination(DE)) }).batch).toBe(true)
    const withPause = destination(IT, { lifecycle: [lifecycle('p1', 'pause')] })
    expect(sendOf({ it: entryOf(withPause) }).batch).toBe(true)
    expect(sendOf({ it: entryOf(withPause, { lifecycleIds: [] }) }).batch).toBe(false)
    const withOutgrown = destination(IT, { outgrown: [{ id: 'o1', listingId: 'l', productId: 'p', sku: 'S', column: 'send', value: 'full', reason: 'Ended on eBay' }] })
    expect(sendOf({ it: entryOf(withOutgrown) }).batch).toBe(true)
  })
  it('a market with only status changes sends them; its content is not in the request', () => {
    const held = destination(IT, { review: null, contentHeld: [{ productId: 'gale', sku: 'GALE-JACKET', reason: 'Being deleted.' }], lifecycle: [lifecycle('d1', 'delete')] })
    const entries = { it: entryOf(held) }
    const send = sendOf(entries)
    expect(send.send).toEqual(['it'])
    expect(send.content).toEqual([])
    const body = planSubmit('gale', send, key => entries[key as 'it'], () => IT, 'GALE-JACKET')
    expect(body).toEqual({ productId: 'gale', destinations: [{ scope: IT }], lifecycle: ['d1'], confirmText: 'GALE-JACKET' })
  })
  it('the request carries each ready market\'s review, token and the outgrown ids', () => {
    const plan = destination(IT, { lifecycle: [lifecycle('p1', 'pause')], outgrown: [{ id: 'o1', listingId: 'l', productId: 'p', sku: 'S', column: 'status', value: 'inactive', reason: 'x' }] })
    const r = plan.review!
    const ticks = initialTicks(r)
    const entries = { it: entryOf(plan, { selection: { reviewId: r.id!, token: 'tok', selectedIds: ticks, fieldCount: ticks.length, products: [], payload: { format: 'json', content: '{}' } } as never }) }
    const send = sendOf(entries)
    const body = planSubmit('gale', send, key => entries[key as 'it'], () => IT, null)
    expect(body.destinations).toEqual([{ scope: IT, reviewId: 'r-IT', selectionToken: 'tok' }])
    expect(body.lifecycle).toEqual(['p1'])
    expect(body.outgrown).toEqual(['o1'])
    expect(body.confirmText).toBeUndefined()
  })
  it('the tab words name the status changes', () => {
    const held = destination(IT, { review: null, lifecycle: [lifecycle('p1', 'pause'), lifecycle('d1', 'delete')] })
    const entry = entryOf(held)
    expect(planTabWords(destinationState(entry, true, NOW), entry)).toBe('1 inactive · 1 delete')
  })
})

describe('after the click: results, words and Undo', () => {
  const child = (over: Partial<PublishPlanBatchChild>): PublishPlanBatchChild => ({
    publicationId: 'c', productId: 'gale', channel: 'EBAY', marketplace: 'IT', accountId: 'ebay', aliasKey: '', status: 'DONE', terminal: true, checked: false,
    message: null, summary: null, kind: 'lifecycle', action: 'pause', step: 'pause', rows: null, ...over,
  })
  it('UNKNOWN reads "Check on the channel"; DONE reads Accepted (only a read-back is Verified)', () => {
    expect(lifecycleChildMeta({ status: 'UNKNOWN', message: null }).label).toBe(CHECK_ON_CHANNEL)
    expect(lifecycleChildMeta({ status: 'DONE', message: null }).label).toBe('Accepted')
    expect(lifecycleChildMeta({ status: 'PREVIEW', message: null }).label).toBe('Waiting its turn')
    expect(lifecycleChildMeta({ status: 'NOT_SENT', message: ROLE_CANNOT_END_OR_DELETE }).hint).toBe(ROLE_CANNOT_END_OR_DELETE)
  })
  it('lists each listing of a finished status change; a done delete cannot be undone', () => {
    const rows = planResultRows([
      child({ publicationId: 'p', rows: [{ productId: 'a', listingId: 'la', sku: 'GALE-S', outcome: 'DONE', message: 'Paused.' }, { productId: 'b', listingId: 'lb', sku: 'GALE-M', outcome: 'UNKNOWN', message: '' }] }),
      child({ publicationId: 'd', action: 'delete', rows: [{ productId: 'c', listingId: 'lc', sku: 'GALE-L', outcome: 'DONE', message: 'Deleted.' }] }),
      child({ publicationId: 'r', kind: 'content', action: null, status: 'ACCEPTED', step: 'content' }),
    ], 'GALE-JACKET')
    expect(rows.map(r => [r.sku, r.what, r.meta.label, r.message])).toEqual([
      ['GALE-S', 'Pause offer', 'Accepted', 'Paused.'],
      ['GALE-M', 'Pause offer', CHECK_ON_CHANNEL, null],
      ['GALE-L', 'Delete listing', 'Accepted', 'Deleted. Cannot be undone.'],
      ['GALE-JACKET', 'Content (Partial and Full update)', 'Accepted', null],
    ])
    expect(planResultWord([child({ terminal: false, status: 'RUNNING' }), child({})])).toBe('1 of 2 done')
  })
  it('a status change without rows yet (refused before sending, waiting its turn) still names each SKU that was sent', () => {
    const sent = [lifecycle('p1', 'pause'), lifecycle('p2', 'pause'), lifecycle('d1', 'delete')]
    const rows = planResultRows([
      child({ publicationId: 'p', action: 'pause', status: 'NOT_SENT', message: 'Nothing was sent.', rows: null }),
      child({ publicationId: 'd', action: 'delete', status: 'PREVIEW', terminal: false, rows: null }),
      child({ publicationId: 'e', action: 'end', status: 'NOT_SENT', rows: null }),
    ], 'GALE-JACKET', sent)
    expect(rows.map(r => [r.key, r.sku, r.what, r.meta.label, r.message])).toEqual([
      ['p:p1', 'GALE-P1', 'Pause offer', 'Not sent', 'Nothing was sent.'],
      ['p:p2', 'GALE-P2', 'Pause offer', 'Not sent', 'Nothing was sent.'],
      ['d:d1', 'GALE-D1', 'Delete listing', 'Waiting its turn', null],
      ['e', '—', 'End listing', 'Not sent', null],
    ])
    expect(planResultWord([child({}), child({ status: 'FAILED' })])).toBe('1 not done')
  })
  it('Undo sets Active again on the paused and ended rows that went through; a delete says it cannot be undone', () => {
    const undo = planUndo([
      child({ action: 'pause', rows: [{ productId: 'a', listingId: 'la', sku: 'A', outcome: 'DONE', message: '' }, { productId: 'b', listingId: 'lb', sku: 'B', outcome: 'FAILED', message: '' }] }),
      child({ action: 'end', rows: [{ productId: 'c', listingId: 'lc', sku: 'C', outcome: 'DONE', message: '' }] }),
      child({ action: 'delete', rows: [{ productId: 'd', listingId: 'ld', sku: 'D', outcome: 'DONE', message: '' }] }),
    ])
    expect(undo).toEqual({ listingIds: ['la', 'lc'], resumed: 1, relisted: 1, ebayRelisted: 1, deleted: 1 })
    expect(undoButtonText(undo)).toBe('Undo: set 2 listings Active again')
    expect(undoSentence(undo)).toContain('1 resume, 1 relist')
    expect(undoSentence(undo)).toContain('1 deleted listing: cannot be undone.')
    expect(undoButtonText(planUndo([]))).toBeNull()
  })
})

describe('the plan answer guard', () => {
  const plan = { productId: 'gale', familyId: 'gale', familySku: 'GALE-JACKET', destinations: [destination(IT, { review: { ...review(IT), productId: 'gale' } })],
    counts: {}, summary: '', confirm: null, canDelete: true, readAt: '' }
  it('accepts a plan for this product and exactly this destination', () => {
    expect(matchesPublishPlan(plan, 'gale', IT)).toBe(true)
    expect(matchesPublishPlan({ ...plan, destinations: [destination(IT, { review: null })] }, 'gale', IT)).toBe(true)
  })
  it('refuses another destination, another product or several destinations', () => {
    expect(matchesPublishPlan(plan, 'gale', DE)).toBe(false)
    expect(matchesPublishPlan(plan, 'other', IT)).toBe(false)
    expect(matchesPublishPlan({ ...plan, destinations: [...plan.destinations, destination(DE)] }, 'gale', IT)).toBe(false)
  })
})

describe('delete and relist in the Publish window', () => {
  const AMAZON_IT: StudioPublishScope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'amz' }
  const skip = 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active.'
  const relist = { deletedAt: '2026-10-04T06:00:00.000Z', oldReference: 'B0OLD12345', asin: 'B0NEW12345', sentence: relistSentence('GALE-L', 'B0NEW12345', 'B0OLD12345', 'AMAZON'),
    warning: 'Amazon holds 14 units labelled for B0OLD12345. They cannot sell on the new ASIN; ask Amazon for a removal order.' }
  const amazonReview = review(AMAZON_IT, {
    rows: [
      { productId: 'gale-s', sku: 'GALE-S', title: 'Jacket S', existing: true, mode: 'partial' },
      { productId: 'gale-m', sku: 'GALE-M', title: 'Jacket M', existing: false, mode: 'partial', blocked: skip, deleted: true },
      { productId: 'gale-l', sku: 'GALE-L', title: 'Jacket L', existing: false, mode: 'partial', relist, startsAs: 'active' },
    ],
    changes: [change('gale-s', 'title'), change('gale-m', '$create', { selectedByDefault: false }), change('gale-l', '$create')],
    removals: [],
  })
  const plan = destination(AMAZON_IT, {
    label: 'Amazon · IT', review: amazonReview, fullProductIds: [],
    contentHeld: [{ productId: 'gale-xl', sku: 'GALE-XL', reason: skip, deleted: true }],
    lifecycle: [lifecycle('del1', 'delete', { warning: `${fbaDeleteWarning({ sellable: 12, inbound: 2, reserved: 0, other: 0, readAt: null })} ${AMAZON_PAN_EU_DELETE_WARNING}` })],
  })
  const entry = entryOf(plan)
  const rows = actionPlanRows(entry, destinationState(entry, true, NOW), NOW)
  const row = (key: string) => rows.find(r => r.key === key)!

  it('a deleted row left Not listed is held — unticked, locked — with the delete\'s sentence; it reads Not listed and sits at the bottom', () => {
    expect(row('content:gale-m')).toMatchObject({ tick: 'none', tickable: false, notSent: skip, sent: skip, notListed: true, creates: null, what: { column: 'status', target: 'not_listed' } })
    expect(row('held:gale-xl')).toMatchObject({ kind: 'held', tick: 'none', sent: skip, notListed: true, what: { column: 'status', target: 'not_listed' } })
    expect(rows.slice(-2).map(r => r.key).sort()).toEqual(['content:gale-m', 'held:gale-xl'])
  })

  it('a row its Status lists again reads Full update (sent whole) and says how — "Lists GALE-L on ASIN B0NEW12345 (was B0OLD12345)." — with its FBA warning', () => {
    expect(row('content:gale-l')).toMatchObject({ sent: 'Lists GALE-L on ASIN B0NEW12345 (was B0OLD12345).', warning: relist.warning, tick: 'on', creates: null,
      what: { column: 'send', mode: 'full', newRow: true } })
    // Listed again Inactive: it says buyers cannot buy it yet.
    const inactive = { ...entry, review: { ...amazonReview, rows: amazonReview.rows.map(r => r.productId === 'gale-l' ? { ...r, startsAs: 'inactive' as const } : r) } }
    expect(actionPlanRows(inactive, destinationState(inactive, true, NOW), NOW).find(r => r.key === 'content:gale-l')!.sent)
      .toBe('Lists GALE-L on ASIN B0NEW12345 (was B0OLD12345). Inactive — buyers cannot buy it yet.')
    const off = actionPlanRows({ ...entry, selectedIds: entry.selectedIds.filter(id => !id.includes('gale-l')) }, destinationState(entry, true, NOW), NOW)
    expect(off.find(r => r.key === 'content:gale-l')!.sent).toBe(`Lists GALE-L on ASIN B0NEW12345 (was B0OLD12345). ${RELIST_UNTICKED}`)
    expect(relistSentence('GALE-L', 'B0OLD12345', 'B0OLD12345', 'AMAZON')).toBe('Lists GALE-L again on ASIN B0OLD12345.')
    // Held back by the review's problems, it still names the relist, then why it waits.
    const blocked = { ...entry, review: { ...amazonReview, issues: [{ severity: 'error' as const, productId: 'gale-s', sku: 'GALE-S', message: 'GALE-S: Brand is required.' }] } }
    const held = actionPlanRows(blocked, destinationState(blocked, true, NOW), NOW).find(r => r.key === 'content:gale-l')!
    expect(held).toMatchObject({ tick: 'none', notSent: NOT_SENT_PROBLEMS, sent: `Lists GALE-L on ASIN B0NEW12345 (was B0OLD12345). ${NOT_SENT_PROBLEMS}`, what: { newRow: true } })
  })

  it('a Delete row carries Amazon\'s FBA unit count and the Pan-European FBA warning', () => {
    expect(row('del1').warning).toBe('Amazon holds 14 FBA units for this SKU here (12 sellable, 2 on the way). They cannot sell until you list this SKU here again, and Amazon still charges storage. '
      + 'This SKU uses Pan-European FBA. Amazon may stop moving stock to this market until you list it here again.')
    expect(row('del1').danger).toBe(true)
  })

  it('Done: a deleted row says how to list it again (the server\'s words, or these when it gave none); Undo says it too', () => {
    const results = planResultRows([{ publicationId: 'd', productId: 'gale', channel: 'AMAZON', marketplace: 'IT', accountId: 'amz', aliasKey: '', status: 'DONE', terminal: true,
      checked: false, message: null, summary: null, kind: 'lifecycle', action: 'delete', step: 'delete',
      rows: [{ productId: 'a', listingId: 'la', sku: 'GALE-S', outcome: 'DONE', message: `${deleteDoneSentence('Amazon · IT')} Other markets keep their listings.` },
        { productId: 'b', listingId: 'lb', sku: 'GALE-M', outcome: 'DONE', message: '' }] }], 'GALE-JACKET')
    expect(results.map(r => r.message)).toEqual([
      'Deleted on Amazon · IT. To list it again, set Status to Active and Publish. Other markets keep their listings. Cannot be undone.',
      'Deleted on Amazon · IT. To list it again, set Status to Active and Publish. Cannot be undone.',
    ])
    expect(undoSentence({ listingIds: [], resumed: 0, relisted: 0, ebayRelisted: 0, deleted: 1 }))
      .toBe('1 deleted listing: cannot be undone. It reads Not listed in the sheet; Publish skips it. To list it again, set its Status to Active and Publish.')
  })
})

describe('new listings in the Publish window', () => {
  const AMAZON_IT: StudioPublishScope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'amz' }
  const amazonReview = review(AMAZON_IT, {
    action: 'create',
    rows: [
      { productId: 'gale', sku: 'GALE', title: 'Jacket', existing: false, mode: 'partial', startsAs: 'active' },
      { productId: 'gale-s', sku: 'GALE-S', title: 'Jacket S', existing: false, mode: 'partial', startsAs: 'active' },
      { productId: 'gale-m', sku: 'GALE-M', title: 'Jacket M', existing: false, mode: 'partial', startsAs: 'inactive' },
    ],
    changes: [change('gale', '$create'), change('gale-s', '$create'), change('gale-m', '$create')],
    removals: [],
  })
  const plan = destination(AMAZON_IT, { label: 'Amazon · IT', review: amazonReview, fullProductIds: [],
    contentHeld: [{ productId: 'gale-l', sku: 'GALE-L', reason: NOT_LISTED_LEFT_OUT, notListed: true }] })
  const entry = entryOf(plan)
  const rows = actionPlanRows(entry, destinationState(entry, true, NOW), NOW)
  const row = (key: string) => rows.find(r => r.key === key)!

  it('a row the review creates reads Full update (a new listing is sent whole) and says how it starts', () => {
    expect(row('content:gale-m')).toMatchObject({ what: { column: 'send', mode: 'full', newRow: true }, tick: 'on', notListed: false,
      creates: { startsAs: 'inactive', sentence: 'Creates GALE-M · Inactive — buyers cannot buy it yet.' } })
    expect(row('content:gale-s').creates?.sentence).toBe('Creates GALE-S · Active.')
    expect(createsLine('GALE', 'inactive', 'SHOPIFY')).toBe('Creates GALE · Inactive (a Draft product) — buyers cannot buy it yet.')
    // Unticked, it says so; it is not counted.
    const off = actionPlanRows({ ...entry, selectedIds: entry.selectedIds.filter(id => !id.includes('gale-m')) }, destinationState(entry, true, NOW), NOW)
    expect(off.find(r => r.key === 'content:gale-m')!.creates?.sentence).toBe(`Creates GALE-M · Inactive — buyers cannot buy it yet. ${CREATE_UNTICKED}`)
    expect(createdCounts(off)).toEqual({ total: 2, inactive: 0 })
  })

  it('the summary lines count the listings this Publish creates', () => {
    expect(createdCounts(rows)).toEqual({ total: 3, inactive: 1 })
    expect(createdWords({ total: 3, inactive: 1 })).toBe('3 new listings (1 inactive)')
    expect(createdWords({ total: 1, inactive: 1 })).toBe('1 new listing (inactive)')
    expect(createdWords({ total: 2, inactive: 2 })).toBe('2 new listings (all inactive)')
    expect(createdWords({ total: 0, inactive: 0 })).toBeNull()
    const counts = { partial: 3, fields: 3, full: 0, delete: 0, active: 0, inactive: 0, ended: 0 }
    expect(planSummaryLine(counts, 0, createdCounts(rows))).toBe('3 partial updates (3 fields) · 3 new listings (1 inactive)')
    expect(planFamilySummary(2, { skipped: [], nothing: [], pending: [] }, counts, 0, [], { total: 3, inactive: 1 })).toBe('2 markets · 3 partial updates (3 fields) · 3 new listings (1 inactive)')
  })

  it('a Not listed row is held — unticked, locked, quiet, at the bottom — and never counted as sent', () => {
    expect(row('held:gale-l')).toMatchObject({ kind: 'held', tick: 'none', tickable: false, notListed: true, notSent: NOT_LISTED_LEFT_OUT,
      what: { column: 'status', target: 'not_listed' }, creates: null })
    expect(rows.at(-1)!.key).toBe('held:gale-l')
    expect(sendOf({ it: entry }).counts.partial).toBe(3)
  })

  it('a main row set Not listed holds its family: each row it lists is held with the reason, nothing is created', () => {
    const heldReview = review(AMAZON_IT, { rows: amazonReview.rows.map(r => ({ ...r, startsAs: undefined, blocked: NOT_LISTED_MAIN_HELD, notListed: true as const })),
      changes: amazonReview.changes!.map(c => ({ ...c, selectable: false, selectedByDefault: false })), removals: [] })
    const held = destination(AMAZON_IT, { label: 'Amazon · IT', review: heldReview, fullProductIds: [] })
    const e = entryOf(held)
    const out = actionPlanRows(e, destinationState(e, true, NOW), NOW)
    expect(out.every(r => r.notListed && r.tick === 'none' && r.notSent === NOT_LISTED_MAIN_HELD && !r.creates)).toBe(true)
    expect(createdCounts(out)).toEqual({ total: 0, inactive: 0 })
  })

  it('the products table says how a new row starts, or that it is left out', () => {
    expect(reviewRowListingWord({ existing: false, startsAs: 'inactive' })).toBe('New listing · Inactive')
    expect(reviewRowListingWord({ existing: false })).toBe('New listing')
    expect(reviewRowListingWord({ existing: true })).toBe('Existing listing')
    expect(reviewRowListingWord({ existing: false, notListed: true })).toBe('Not listed: left out')
  })

  it('a new Shopify product says Active or Draft in plain words', () => {
    const rowsNew = [{ productId: 'g', sku: 'G', title: 'G', existing: false }]
    expect(shopifyVisibilityWords({ visibility: 'ACTIVE', action: 'create', rows: rowsNew })?.title).toBe('Shopify creates this product Active')
    expect(shopifyVisibilityWords({ visibility: 'DRAFT', action: 'create', rows: rowsNew })).toEqual({ title: 'Shopify creates this product as a Draft',
      body: 'Buyers cannot buy it until you set it Active and Publish. The saved sales-channel selections are applied.' })
    expect(shopifyVisibilityWords({ visibility: 'ACTIVE', action: 'update', rows: [{ ...rowsNew[0], existing: true }] })?.title).toBe('Shopify status: Active')
    expect(shopifyVisibilityWords({ visibility: undefined, action: 'create', rows: rowsNew })).toBeNull()
  })
})

// ── S10 (per-channel SKU): a live listing moved to its own SKU, and the SKU each line names ─────────────────────────────
describe('S10 — a SKU move in the Publish window', () => {
  const AMAZON_IT: StudioPublishScope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'amz' }
  const move = { from: 'GALE-S', to: 'GALE-S-IT', kind: 'create-delete' as const, sentence: 'Creates GALE-S-IT on Amazon · IT as a new offer, then deletes GALE-S there.', warning: 'GALE-S-IT starts with no FBA units.' }
  const moving = (over: Partial<StudioPublishReview> = {}) => destination(AMAZON_IT, { label: 'Amazon · IT', fullProductIds: [], review: review(AMAZON_IT, {
    rows: [{ productId: 'gale-s', sku: 'GALE-S', title: 'Jacket S', existing: true, mode: 'move', sendsSku: 'GALE-S-IT', skuMove: move },
      { productId: 'gale-m', sku: 'GALE-M', title: 'Jacket M', existing: true, mode: 'partial' }],
    changes: [change('gale-s', '$create'), change('gale-m', 'title')], removals: undefined,
    confirm: { kind: 'type', expected: 'GALE-JACKET', token: 'DELETE', sentence: 'This Publish deletes GALE-S on Amazon · IT once Amazon accepts its new SKU.' }, ...over }) })

  it('the row reads its own mode, "Move to NEW" — never Partial or Full update — as a danger row first, with its FBA note', () => {
    const plan = moving()
    const rows = actionPlanRows(entryOf(plan), destinationState(entryOf(plan), true, NOW), NOW)
    const row = rows.find(r => r.key === 'content:gale-s')!
    expect(row.what).toEqual({ column: 'move', from: 'GALE-S', to: 'GALE-S-IT' })
    expect(moveModeLabel('GALE-S-IT')).toBe('Move to GALE-S-IT')
    expect(row.sent).toBe(move.sentence)
    expect(row.warning).toBe(move.warning)
    expect(row.danger).toBe(true)
    expect(row.expandable).toBe(false)
    expect(rows.map(r => r.key)).toEqual(['content:gale-s', 'content:gale-m'])
    expect(rows.find(r => r.key === 'content:gale-m')!.what).toMatchObject({ column: 'send', mode: 'partial' })
  })

  it('S11 follow-up — the typed confirmation names each listing by the SKU it holds; more than three, or one SKU twice, are counted', () => {
    // The plan names an End or Delete row by the SKU the channel holds for that listing (its own, not the product SKU).
    const held = destination(IT, { lifecycle: [lifecycle('d1', 'delete', { sku: 'GALE-M-OLD' }), lifecycle('d2', 'delete', { sku: 'GALE-L' })] })
    expect(confirmSentence(sendOf({ it: entryOf(held) }).confirm!)).toBe('Type GALE-JACKET to delete GALE-M-OLD and GALE-L on eBay · IT')
    const many = destination(IT, { lifecycle: ['a', 'b', 'c', 'd'].map(id => lifecycle(id, 'delete')) })
    expect(confirmSentence(sendOf({ it: entryOf(many) }).confirm!)).toBe('Type GALE-JACKET to delete 4 listings on eBay · IT')
    expect(confirmWhat({ ended: 0, deleted: 2, places: [], skus: { ended: [], deleted: ['GALE-M'] } })).toBe('to delete 2 listings')
    expect(confirmWhat({ ended: 1, deleted: 0, places: ['eBay · IT'] })).toBe('to end 1 listing on eBay · IT')
  })

  it('the summary and the button count a move as a move, not a partial update', () => {
    const entries = { it: entryOf(moving()) }
    const send = sendOf(entries)
    expect(send.counts).toMatchObject({ partial: 1, fields: 1, full: 0, moved: 1 })
    expect(planSummaryLine(send.counts)).toBe('1 partial update (1 field) · 1 move to a new SKU')
    expect(planButtonText({ ...send.counts, delete: 1 }, ['it'], { one: 'market', many: 'markets' })).toBe('Publish 2 listings · delete 1')
  })

  it('a ticked move asks for the typed family SKU like Delete, and goes through the batch with confirmDelete', () => {
    const entries = { it: entryOf(moving()) }
    const send = sendOf(entries)
    expect(send.confirm).toEqual({ expected: 'GALE-JACKET', ended: 0, deleted: 0, places: ['Amazon · IT'], moved: 1 })
    expect(send.batch).toBe(true)
    expect(confirmSentence(send.confirm!)).toBe('Type GALE-JACKET to move 1 listing to its new SKU (its old SKU is deleted) on Amazon · IT')
    const body = planSubmit('gale', send, key => entries[key as 'it'], () => AMAZON_IT, 'GALE-JACKET')
    expect(body.destinations[0]).toMatchObject({ reviewId: 'r-IT', confirmDelete: true })
    expect(body.confirmText).toBe('GALE-JACKET')
  })

  it('an unticked move asks for nothing, sends no confirmDelete, and says the old SKU stays', () => {
    const plan = moving()
    const entry = entryOf(plan, { selectedIds: [] })
    expect(sendOf({ it: entry }).confirm).toBeNull()
    const row = actionPlanRows(entry, destinationState(entry, true, NOW), NOW).find(r => r.key === 'content:gale-s')!
    expect(row.sent).toBe(`${move.sentence} Unticked: nothing is created, and the old SKU stays.`)
    expect(row.what).toEqual({ column: 'move', from: 'GALE-S', to: 'GALE-S-IT' })
  })

  it('a create line names the SKU it sends (the listing\'s own)', () => {
    const plan = destination(AMAZON_IT, { label: 'Amazon · IT', fullProductIds: [], review: review(AMAZON_IT, {
      rows: [{ productId: 'gale-s', sku: 'GALE-S', title: 'Jacket S', existing: false, mode: 'partial', startsAs: 'active', sendsSku: 'GALE-S-IT' }],
      changes: [change('gale-s', '$create')], removals: undefined, action: 'create' }) })
    const row = actionPlanRows(entryOf(plan), destinationState(entryOf(plan), true, NOW), NOW).find(r => r.key === 'content:gale-s')!
    expect(row.creates?.sentence).toBe(createsLine('GALE-S-IT', 'active', 'AMAZON'))
  })
})

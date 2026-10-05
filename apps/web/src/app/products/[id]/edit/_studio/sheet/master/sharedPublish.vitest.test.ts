/**
 * Build shape v2, P9 — the SHARED scope's Status and Action columns, its Action ▾, the header's selling pill and the
 * Publish button's count. One sheet row = one product; its cells summarise every market of the product, and a choice
 * is written to every market where it is allowed (the Owner's option B).
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_WAITING, type PublishActionCell, type PublishActionWriteResult } from '@nexus/shared/publish-actions'
import type { PublishActionWriteOutcome } from '../usePublishActions'
import {
  SHARED_ALL_DELETED, SHARED_MIXED_REFUSED, SHARED_NOT_LISTED, SHARED_ONLY_DRAFTS, commonStatusTarget, parseSharedStatusInput, sharedStatusEditorOptions,
  sharedStatusSheetColumn, sharedStatusValue,
} from './sharedStatusColumn'
import {
  SHARED_ACTION_MIXED_REFUSED, commonSendMode, listingWords, parseSharedSendInput, sharedActionEditorOptions, sharedActionMenuEntries,
  sharedActionValue, sharedDeleteImpact, sharedDeletedRefusal, sharedOperationToast, sharedPartialHint,
} from './sharedActionColumn'
import { ETSY_FIELDS_NOT_SENT, SHOPIFY_EXISTING_NOT_YET } from '@nexus/shared/publish-actions'
import { ENDED_NEEDS_DELETE } from '../channel/statusColumn'
import {
  cellsByProduct, headerSellingOf, marketLabel, marketLine, publishButtonWords, publishWaitingCount, sellingSummaryOf, statusWaitingOf,
} from '../../SellingSummary'

const T0 = '2026-10-04T08:00:00.000Z'
const NOW = Date.parse('2026-10-04T10:00:00.000Z')
const read = { loaded: true, failed: false, lockedReason: null }

let seq = 0
function cell(over: Partial<PublishActionCell> & { endOffered?: boolean; deleteOffered?: boolean } = {}): PublishActionCell {
  const { endOffered = false, deleteOffered = true, ...rest } = over
  seq += 1
  return {
    listingId: `l${seq}`, productId: 'p1', sku: 'GALE-M', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '',
    state: 'active', stateReason: null,
    send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: true, reason: null, warning: null },
      { mode: 'full', offered: true, reason: null, warning: null },
      { mode: 'delete', offered: deleteOffered, reason: deleteOffered ? null : 'Amazon holds FBA units for this offer.', warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
      { target: 'inactive', offered: true, action: 'pause', reason: null, warning: null, checkedAtSend: null },
      { target: 'ended', offered: endOffered, action: 'end', reason: endOffered ? null : 'Amazon has no End.', warning: null, checkedAtSend: null },
    ],
    ...rest,
  }
}
const ebay = (over: Partial<PublishActionCell> = {}) => cell({ channel: 'EBAY', endOffered: true, ...over })
const waitingStatus = (target: 'active' | 'inactive' | 'ended', by = 'Awais') =>
  ({ target, setAt: T0, setById: 'u1', setByName: by, noLongerApplies: null })
const waitingSend = (mode: 'full' | 'delete', by = 'Awais') => ({ mode, setAt: T0, setById: 'u1', setByName: by, noLongerApplies: null })

describe('the shared words of one product (sellingSummaryOf)', () => {
  it('"Active" when every market agrees, "Active in 5 of 7" when some differ, "Mixed" when none sells', () => {
    expect(sellingSummaryOf([cell(), cell({ marketplace: 'DE' })]).word).toBe('Active')
    const seven = [...Array.from({ length: 5 }, (_, i) => cell({ marketplace: `M${i}` })), cell({ state: 'paused' }), cell({ state: 'ended' })]
    const summary = sellingSummaryOf(seven)
    expect(summary.word).toBe('Active in 5 of 7')
    expect(summary.tone).toBe('warning')
    expect(sellingSummaryOf([cell({ state: 'paused' }), cell({ state: 'ended' })]).word).toBe('Mixed')
    expect(sellingSummaryOf([]).word).toBe('Not listed')
  })

  it('names each market "Amazon · IT" and an extra listing on a market as an alias', () => {
    expect(marketLabel(cell())).toBe('Amazon · IT')
    expect(marketLabel(cell({ aliasKey: 'b' }))).toBe('Amazon · IT · alias')
  })

  it('groups the family\'s listings by product, in a stable market order', () => {
    const map = cellsByProduct([cell({ marketplace: 'IT' }), cell({ productId: 'p2' }), cell({ marketplace: 'DE' })])
    expect(map.get('p1')!.map(c => c.marketplace)).toEqual(['DE', 'IT'])
    expect(map.get('p2')).toHaveLength(1)
  })

  it('a market line says the state and what waits, with who and when', () => {
    const line = marketLine(cell({ status: waitingStatus('inactive'), send: waitingSend('full') }), NOW)
    expect(line).toMatch(/^Amazon · IT: Active\. Inactive waits for Publish, set by Awais/)
    expect(line).toMatch(/Full update waits for Publish/)
  })
})

describe('the shared Status cell', () => {
  it('is a skeleton until the first read answers — never a guessed state', () => {
    expect(sharedStatusValue([cell()], { ...read, loaded: false })).toBeUndefined()
  })

  it('shows the live summary when nothing waits', () => {
    const value = sharedStatusValue([cell(), cell({ marketplace: 'DE' })], read, NOW)!
    expect(value.pill).toEqual({ label: 'Active', tone: 'success', glyph: 'dot' })
    expect(value.aside).toBeNull()
    expect(value.common).toBe('active')
    expect(value.ariaLabel).toBe('Status: Active on 2 markets.')
    expect(value.tooltip).toContain('Amazon · DE: Active.')
  })

  it('a value waiting on every market is a clock pill with the live words beside it', () => {
    const value = sharedStatusValue([cell({ status: waitingStatus('inactive') }), cell({ marketplace: 'DE', status: waitingStatus('inactive') })], read, NOW)!
    expect(value.pill).toMatchObject({ label: 'Inactive', glyph: 'clock', tone: 'warning' })
    expect(value.aside).toBe('now Active')
    expect(value.ariaLabel).toMatch(/Inactive waits for Publish on every market \(2\), set by Awais/)
  })

  it('a value waiting on some markets says on how many: "Inactive on 3 of 7"', () => {
    const cells = [...Array.from({ length: 3 }, () => cell({ status: waitingStatus('inactive') })), ...Array.from({ length: 4 }, () => cell())]
    expect(sharedStatusValue(cells, read, NOW)!.pill!.label).toBe('Inactive on 3 of 7')
  })

  it('different waiting values: "2 waiting", in the danger tone when an End waits', () => {
    const value = sharedStatusValue([ebay({ status: waitingStatus('ended') }), cell({ status: waitingStatus('inactive') })], read, NOW)!
    expect(value.pill).toMatchObject({ label: '2 waiting', tone: 'danger' })
  })

  it('a product with no listing, or only drafts, is locked with the reason', () => {
    expect(sharedStatusValue([], read)!.lockedReason).toBe(SHARED_NOT_LISTED)
    expect(sharedStatusValue([cell({ state: 'draft' })], read)!.lockedReason).toBe(SHARED_ONLY_DRAFTS)
    expect(sharedStatusValue([cell()], { ...read, lockedReason: 'Your role cannot publish listings.' })!.lockedReason).toBe('Your role cannot publish listings.')
  })

  it('"No longer applies" does not count as waiting', () => {
    const outgrown = cell({ status: { ...waitingStatus('inactive'), noLongerApplies: 'Already inactive on Amazon.' } })
    expect(statusWaitingOf([outgrown])).toBeNull()
  })

  it('the editor counts the markets that allow each Status and holds the one none allows', () => {
    const options = sharedStatusEditorOptions([cell(), cell({ marketplace: 'DE' }), ebay()], true)
    const ended = options.find(o => o.value === 'ended')!
    expect(ended.heldReason).toBeUndefined()
    expect(ended.note).toBe('1 of 3 markets. 2 not allowed: Amazon has no End.')
    expect(options.find(o => o.value === 'inactive')!.note).toBe('Every market (3).')
    const amazonOnly = sharedStatusEditorOptions([cell(), cell({ marketplace: 'DE' })], true)
    expect(amazonOnly.find(o => o.value === 'ended')!.heldReason).toBe('Amazon has no End.')
  })

  it('Ended needs products.delete', () => {
    const options = sharedStatusEditorOptions([ebay(), ebay({ marketplace: 'DE' })], false)
    expect(options.find(o => o.value === 'ended')!.heldReason).toBe(ENDED_NEEDS_DELETE)
  })

  it('a fill copies the common value; "Mixed" cannot be copied; an Action is refused', () => {
    const uniform = sharedStatusValue([cell({ status: waitingStatus('inactive') })], read)!
    expect(parseSharedStatusInput(uniform)).toEqual({ change: { column: 'status', target: 'inactive' } })
    const mixed = sharedStatusValue([cell({ state: 'paused' }), cell()], read)!
    expect(commonStatusTarget([cell({ state: 'paused' }), cell()])).toBeNull()
    expect(parseSharedStatusInput(mixed)).toEqual({ refused: SHARED_MIXED_REFUSED })
    expect(parseSharedStatusInput(sharedActionValue([cell()], read)!)).toHaveProperty('refused')
    expect(parseSharedStatusInput('Pause')).toEqual({ change: { column: 'status', target: 'inactive' } })
    expect(parseSharedStatusInput(null)).toEqual({ change: { column: 'status', target: null } })
  })

  it('is a system column of the Publish group, never a write field', () => {
    const column = sharedStatusSheetColumn<{ key: string; writeField: string; managedBy: string; group: string }>()
    expect(column).toMatchObject({ key: 'publish:status', writeField: '', managedBy: 'progress', group: 'Publish' })
  })
})

describe('the shared Action cell', () => {
  it('Partial update is quiet', () => {
    const value = sharedActionValue([cell(), cell()], read)!
    expect(value.pill).toBeNull()
    expect(value.quiet).toBe('Partial update')
    expect(value.common).toBe('partial')
  })

  it('"Delete on 2 of 7" in the danger tone; one value everywhere is the plain word', () => {
    const cells = [cell({ send: waitingSend('delete') }), cell({ send: waitingSend('delete') }), ...Array.from({ length: 5 }, () => cell())]
    expect(sharedActionValue(cells, read)!.pill).toMatchObject({ label: 'Delete on 2 of 7', tone: 'danger', glyph: 'clock' })
    expect(sharedActionValue([cell({ send: waitingSend('full') })], read)!.pill!.label).toBe('Full update')
  })

  it('different waiting values: "2 waiting" with what waits beside it', () => {
    const value = sharedActionValue([cell({ send: waitingSend('delete') }), cell({ send: waitingSend('full') })], read)!
    expect(value.pill!.label).toBe('2 waiting')
    expect(value.aside).toBe('1 delete · 1 full update')
    expect(commonSendMode([cell({ send: waitingSend('delete') }), cell()])).toBeNull()
    expect(parseSharedSendInput(value)).toEqual({ refused: SHARED_ACTION_MIXED_REFUSED })
  })

  // Wave 2 D5 / D13 — a product already on Shopify, and Etsy: the quiet hint never says "only the fields you changed" there.
  it('Partial update names what Publish does not send on Shopify (already on it) and Etsy markets', () => {
    const partial = (warning: string | null) => [
      { mode: 'partial' as const, offered: true, reason: null, warning },
      { mode: 'full' as const, offered: !warning, reason: warning, warning: null },
      { mode: 'delete' as const, offered: true, reason: null, warning: null },
    ]
    const shopify = cell({ channel: 'SHOPIFY', marketplace: 'GLOBAL', sendOptions: partial(SHOPIFY_EXISTING_NOT_YET) })
    const etsy = cell({ channel: 'ETSY', marketplace: 'GLOBAL', sendOptions: partial(ETSY_FIELDS_NOT_SENT) })
    // One Shopify market: the channel scope's sentence, alone.
    const only = sharedActionValue([shopify], read)!
    expect(only.ariaLabel).toBe(`Action: Partial update. ${SHOPIFY_EXISTING_NOT_YET}`)
    expect(only.tooltip).not.toContain('only the fields you changed')
    // Amazon, Shopify and Etsy: each sentence after its market, then the other markets.
    const hint = `Shopify · GLOBAL: ${SHOPIFY_EXISTING_NOT_YET} Etsy · GLOBAL: ${ETSY_FIELDS_NOT_SENT} Other markets: Publish sends only the fields you changed.`
    expect(sharedPartialHint([cell(), shopify, etsy])).toBe(hint)
    expect(sharedActionValue([cell(), shopify, etsy], read)!.ariaLabel).toBe(`Action: Partial update on every market (3). ${hint}`)
    // No note anywhere: the usual hint.
    expect(sharedPartialHint([cell(), cell({ marketplace: 'DE' })])).toBeNull()
    expect(sharedActionValue([cell(), cell({ marketplace: 'DE' })], read)!.ariaLabel).toBe('Action: Partial update on every market (2). Publish sends only the fields you changed.')
    // The editor's Partial update says the same.
    expect(sharedActionEditorOptions([shopify, etsy], true).find(o => o.value === 'partial')!.note)
      .toBe(`The default. Shopify · GLOBAL: ${SHOPIFY_EXISTING_NOT_YET} Etsy · GLOBAL: ${ETSY_FIELDS_NOT_SENT}`)
    expect(sharedActionEditorOptions([cell(), cell()], true).find(o => o.value === 'partial')!.note).toBe('The default. Only the fields you changed.')
  })

  it('the editor counts Delete across markets and says it is confirmed first', () => {
    const options = sharedActionEditorOptions([cell(), cell({ deleteOffered: false })], true)
    expect(options.find(o => o.value === 'delete')!.note).toBe('1 of 2 markets. 1 not allowed: Amazon holds FBA units for this offer. You confirm the listings first.')
    expect(sharedActionEditorOptions([cell(), cell()], false).find(o => o.value === 'delete')!.heldReason).toMatch(/cannot end or delete/)
  })
})

describe('Action ▾ on the ticked products', () => {
  it('counts every market of every ticked product, in listings', () => {
    const rows = [
      { sku: 'GALE-S', cells: [cell(), cell({ marketplace: 'DE' }), ebay()] },
      { sku: 'GALE-M', cells: [cell(), ebay()] },
      { sku: 'GALE-L', cells: [] },
    ]
    const entries = sharedActionMenuEntries(rows, { publish: true, delete: true })
    const inactive = entries.find(e => e.id === 'status:inactive')!
    expect(inactive.label).toBe('Inactive — 5 of 6 listings')
    expect(inactive.note).toMatch(/^1 not allowed: Not on the channel yet/)
    expect(entries.find(e => e.id === 'status:ended')!.label).toBe('Ended — 2 of 6 listings')
    expect(entries.map(e => e.group)).toEqual(['Status', 'Status', 'Status', 'Send as', 'Send as', 'Send as'])
  })

  it('Ended and Delete are disabled without products.delete', () => {
    const entries = sharedActionMenuEntries([{ sku: 'GALE-S', cells: [ebay()] }], { publish: true, delete: false })
    expect(entries.find(e => e.id === 'status:ended')!.disabled).toBe(true)
    expect(entries.find(e => e.id === 'send:delete')!.disabled).toBe(true)
    expect(entries.find(e => e.id === 'status:inactive')!.disabled).toBe(false)
  })
})

describe('a shared Delete is confirmed by listing what it removes', () => {
  it('lists every listing, names the ones that stay, and asks for the SKU typed', () => {
    const impact = sharedDeleteImpact([
      { sku: 'GALE-S', cell: cell() },
      { sku: 'GALE-S', cell: ebay() },
      { sku: 'GALE-S', cell: cell({ marketplace: 'DE', deleteOffered: false }) },
    ], true)!
    expect(impact.level).toBe('type-to-confirm')
    expect(impact.title).toBe('Set Delete on 2 listings of GALE-S?')
    expect(impact.consequences).toHaveLength(2)
    expect(impact.consequences![0]).toMatch(/^GALE-S · Amazon · IT — removed from the channel when you press Publish/)
    expect(impact.findings![0].label).toBe('GALE-S · Amazon · DE stays: Amazon holds FBA units for this offer.')
    expect(impact.confirmPhrase).toBe('GALE-S')
  })

  it('several products: the number of listings is the phrase', () => {
    const impact = sharedDeleteImpact([{ sku: 'GALE-S', cell: cell() }, { sku: 'GALE-M', cell: cell() }, { sku: 'GALE-M', cell: ebay() }], true)!
    expect(impact.title).toBe('Set Delete on 3 listings of 2 products?')
    expect(impact.confirmPhrase).toBe('3')
  })

  it('asks nothing when no listing allows it, or the viewer may not delete', () => {
    expect(sharedDeleteImpact([{ sku: 'GALE-S', cell: cell({ deleteOffered: false }) }], true)).toBeNull()
    expect(sharedDeleteImpact([{ sku: 'GALE-S', cell: cell() }], false)).toBeNull()
  })
})

describe('the one toast of a shared operation', () => {
  const outcome = (result: Partial<PublishActionWriteResult>, change: PublishActionWriteOutcome['change'] = { column: 'status', target: 'inactive' }): PublishActionWriteOutcome =>
    ({ ok: true, change, requested: [], applied: result.applied ?? [], refused: result.refused ?? [], conflicts: result.conflicts ?? [], error: null })

  it('counts listings and names each refused one by product and market', () => {
    const labels: Record<string, string> = { l9: 'GALE-S · Amazon · IT' }
    const toast = sharedOperationToast([outcome({ applied: ['a', 'b', 'c', 'd', 'e'], refused: [{ listingId: 'l9', sku: 'GALE-S', reason: 'Amazon has no End.' }] }, { column: 'status', target: 'ended' })],
      [], id => labels[id] ?? null)!
    expect(toast.tone).toBe('warning')
    expect(toast.message).toMatch(/^Ended set on 5 listings\./)
    expect(toast.message).toContain('GALE-S · Amazon · IT')
    expect(toast.message).not.toMatch(/\brows?\b/)
  })

  it('"rows" become "listings"', () => {
    expect(listingWords('Inactive set on 18 rows. 1 row was changed')).toBe('Inactive set on 18 listings. 1 listing was changed')
  })
})

describe('the header pill and the Publish button', () => {
  it('"Active on 5 of 7" (warning when a market is inactive), "Not listed" without a listing on a channel', () => {
    const cells = [...Array.from({ length: 5 }, () => cell()), cell({ state: 'paused' }), cell({ state: 'draft' })]
    expect(headerSellingOf(cells, EMPTY_WAITING)).toMatchObject({ label: 'Active on 5 of 7', tone: 'warning', live: 5, total: 7 })
    expect(headerSellingOf([cell(), cell()], EMPTY_WAITING)).toMatchObject({ label: 'Active on 2 of 2', tone: 'success' })
    expect(headerSellingOf([cell({ state: 'draft' })], EMPTY_WAITING)).toMatchObject({ label: 'Not listed', tone: 'neutral' })
    expect(headerSellingOf([], EMPTY_WAITING).ariaLabel).toBe('Not listed on any market yet.')
  })

  it('danger, with the words, when an End or a Delete waits anywhere in the family', () => {
    const head = headerSellingOf([cell()], { ...EMPTY_WAITING, ended: 1, delete: 2 })
    expect(head.tone).toBe('danger')
    expect(head.label).toBe('Active on 1 of 1 · 1 to end · 2 to delete')
    expect(head.ariaLabel).toMatch(/In this family, 3 waiting for Publish: 1 ended · 2 deletes\./)
  })

  it('the Publish button counts every waiting value of the family', () => {
    expect(publishButtonWords(EMPTY_WAITING).label).toBe('Publish')
    expect(publishButtonWords(null).label).toBe('Publish')
    const waiting = { ...EMPTY_WAITING, inactive: 2, full: 1, delete: 1 }
    expect(publishWaitingCount(waiting)).toBe(4)
    const words = publishButtonWords(waiting)
    expect(words.label).toBe('Publish · 4')
    expect(words.ariaLabel).toBe('Publish. 4 waiting for Publish: 2 inactive · 1 full update · 1 delete.')
  })
})

describe('delete and relist (simplify) — a market Nexus deleted, in the shared scope', () => {
  const words = 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.'
  const deleted = (over: Partial<PublishActionCell> = {}) => cell({
    state: 'not_listed', stateReason: words,
    deleted: { at: '2026-10-04T06:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD12345', relistChosenAt: null, sentence: 'Deleted on Amazon · IT on 4 Oct.' },
    create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed', noRecord: false, sentence: words },
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [{ mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null }, { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.', warning: null }],
    statusOptions: (['active', 'inactive', 'not_listed'] as const).map(target => ({ target, offered: true, action: null, reason: null, warning: null, checkedAtSend: null })),
    ...over,
  })
  const refusal = 'Deleted on Amazon · IT. To list it again, set its Status in the Amazon · IT sheet.'

  it('the refusal is the server\'s own sentence for a refused fan-out', () => {
    expect(sharedDeletedRefusal(deleted())).toBe(refusal)
  })

  it('an UNLINKED market says the unlink\'s truth: counted "1 unlinked", never "lists again" or "list it again"', () => {
    const unlinked = deleted({ deleted: { at: '2026-10-05T06:00:00.000Z', where: 'eBay · IT', oldReference: '520000000001', relistChosenAt: null, sku: null, unlinked: true,
      sentence: 'Unlinked from eBay · IT on 5 Oct: the item may still be live there, and Nexus no longer updates it.' } })
    const said = 'Unlinked from eBay · IT: the item may still be live there, and Nexus no longer updates it. Link its Item ID again in the eBay · IT sheet.'
    expect(sharedDeletedRefusal(unlinked)).toBe(said)
    expect(sellingSummaryOf([cell({ marketplace: 'DE' }), unlinked])).toMatchObject({ deleted: 0, unlinked: 1 })
    expect(sharedStatusValue([cell({ marketplace: 'DE' }), unlinked], read, NOW)).toMatchObject({ aside: '1 unlinked' })
    expect(sharedStatusValue([unlinked], read, NOW)!.lockedReason).toBe(said)
    expect(sharedStatusValue([unlinked, deleted({ marketplace: 'DE' })], read, NOW)!.lockedReason).not.toMatch(/^Deleted on every market/)
    expect(sharedActionValue([cell({ marketplace: 'DE' }), unlinked], read, NOW)!.aside).toBe('1 unlinked')
  })

  it('Status: a deleted market reads Not listed (counted "1 deleted"), its line says why; deleted on every market = read-only', () => {
    const cells = [cell({ marketplace: 'DE' }), deleted()]
    expect(sellingSummaryOf(cells)).toMatchObject({ word: 'Active in 1 of 2', deleted: 1, fresh: 0 })
    const value = sharedStatusValue(cells, read, NOW)!
    expect(value).toMatchObject({ lockedReason: null, aside: '1 deleted' })
    expect(value.tooltip).toContain(`Amazon · IT: Not listed. ${words}`)
    // Listing it again is chosen in its own sheet: here every Status is refused on it, with the server's words.
    expect(sharedStatusEditorOptions(cells, true).find(o => o.value === 'inactive')!.note).toBe(`1 of 2 markets. 1 not allowed: ${refusal}`)
    expect(sharedStatusEditorOptions([deleted()], true).every(o => o.heldReason === refusal)).toBe(true)
    expect(sharedStatusValue([deleted()], read, NOW)!.lockedReason).toBe(refusal)
    expect(sharedStatusValue([deleted(), deleted({ marketplace: 'DE' })], read, NOW)!.lockedReason).toBe(SHARED_ALL_DELETED)
    // Its own Status choice (made in its own sheet) waits; one set before the delete does not.
    expect(statusWaitingOf([deleted({ status: { ...waitingStatus('inactive'), noLongerApplies: 'Set before the delete on 4 Oct.' } })])).toBeNull()
  })

  it('Action: the other markets\' summary, with the deleted ones named ("1 deleted", "1 lists again"); deleted everywhere reads Full update, quiet', () => {
    const value = sharedActionValue([cell({ marketplace: 'DE' }), deleted()], read, NOW)!
    expect(value).toMatchObject({ pill: null, quiet: 'Partial update', aside: '1 deleted' })
    expect(value.tooltip).toContain('Amazon · IT: Full update, but its Status is Not listed: Publish leaves it out. Deleted on Amazon · IT on 4 Oct.')
    expect(sharedActionValue([deleted(), deleted({ marketplace: 'DE' })], read, NOW)!).toMatchObject({ pill: null, quiet: 'Full update', common: null, notOnChannel: true })
    const again = deleted({ status: waitingStatus('active'), create: { target: 'active', source: 'own', defaultTarget: 'not_listed', noRecord: false, sentence: 'Publish lists it again, whole, and it sells.' } })
    expect(sharedActionValue([cell({ marketplace: 'DE' }), again], read, NOW)!).toMatchObject({ quiet: 'Partial update', aside: '1 lists again' })
    expect(sharedActionValue([cell({ marketplace: 'DE', send: waitingSend('full') }), again], read, NOW)!).toMatchObject({ pill: { label: 'Full update on 1 of 2' }, aside: '1 lists again' })
  })

  it('every Status and Action on a deleted market is refused with the reason: editor, Action ▾ and the Delete confirmation', () => {
    const options = sharedActionEditorOptions([cell({ marketplace: 'DE' }), deleted()], true)
    expect(options.find(o => o.value === 'full')!.note).toBe(`1 of 2 markets. 1 not allowed: ${refusal}`)
    expect(options.find(o => o.value === 'partial')!.note).toMatch(/1 deleted market stays as it is: set its Status in its own sheet\.$/)
    // One market, deleted: no channel options here (its own sheet lists it again).
    expect(sharedActionEditorOptions([deleted()], true).every(o => o.heldReason === refusal)).toBe(true)
    const entries = sharedActionMenuEntries([{ sku: 'GALE-M', cells: [cell({ marketplace: 'DE' }), deleted()] }], { publish: true, delete: true })
    expect(entries.find(e => e.id === 'send:full')).toMatchObject({ label: 'Full update — 1 of 2 listings', note: `1 not allowed: ${refusal}` })
    expect(entries.find(e => e.id === 'status:active')).toMatchObject({ label: 'Active — 1 of 2 listings', note: `1 not allowed: ${refusal}` })
    const impact = sharedDeleteImpact([{ sku: 'GALE-M', cell: cell({ marketplace: 'DE' }) }, { sku: 'GALE-M', cell: deleted() }], true)!
    expect(impact.consequences).toHaveLength(1)
    expect(impact.findings).toEqual([{ label: `GALE-M · Amazon · IT stays: ${refusal}`, severity: 'warn' }])
    expect(impact.sideEffects).toContain('After Publish it cannot be undone: each listing then reads Not listed in its market\'s sheet. To list it again, set its Status there to Active and Publish.')
  })
})

// ── New listings (Owner 2026-10-04) ───────────────────────────────────────────────────────────────────────────────

function fresh(over: Partial<PublishActionCell> = {}): PublishActionCell {
  return cell({
    marketplace: 'FR', state: 'draft',
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: false, sentence: 'Publish creates it and it sells.' },
    sendOptions: [
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Nothing to delete yet. To leave it out, set Status to Not listed.', warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish creates it and it sells.' },
      { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish creates it, but buyers cannot buy it yet.' },
      { target: 'not_listed', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish leaves it out.' },
    ],
    ...over,
  })
}

describe('new listings in the shared scope', () => {
  it('the Status cell counts the new markets ("Active in 5 of 7 · 2 new") and stays editable', () => {
    const cells = [cell(), cell({ marketplace: 'DE' }), cell({ marketplace: 'ES' }), cell({ marketplace: 'NL' }), cell({ marketplace: 'SE' }), fresh(), fresh({ marketplace: 'PL' })]
    const summary = sellingSummaryOf(cells)
    expect(summary).toMatchObject({ total: 7, active: 5, fresh: 2, word: 'Active in 5 of 7' })
    const value = sharedStatusValue(cells, read, NOW)!
    expect(value).toMatchObject({ aside: '2 new', lockedReason: null })
    expect(value.ariaLabel).toContain('2 markets are new listings')
    expect(marketLine(cells[5], NOW)).toBe('Amazon · FR: New listing. Publish creates it and it sells.')
  })

  it('a product new on every market shows its choice, not the drafts\' state; the editor adds Not listed, counted', () => {
    const own = { target: 'inactive' as const, setAt: T0, setById: 'u1', setByName: 'Awais', noLongerApplies: null }
    const cells = [fresh({ status: own, create: { target: 'inactive', source: 'own', defaultTarget: 'active', noRecord: false, sentence: '' } }),
      fresh({ marketplace: 'PL', status: own, create: { target: 'inactive', source: 'own', defaultTarget: 'active', noRecord: false, sentence: '' } })]
    const value = sharedStatusValue(cells, read, NOW)!
    expect(value.pill).toEqual({ label: 'Inactive', tone: 'warning', glyph: 'clock' })
    expect(value).toMatchObject({ aside: '2 new', lockedReason: null, common: 'inactive' })
    const options = sharedStatusEditorOptions(cells, true)
    // Ended only where a market's channel can end a listing (none here).
    expect(options.map(o => o.value)).toEqual(['active', 'inactive', 'not_listed'])
    expect(options[1].note).toBe('Every market (2). Waiting for Publish on every market.')
  })

  it('the Action cell reads Full update for new markets (sent whole): counted beside Partial update, a pill when new everywhere; never copied', () => {
    const mixed = sharedActionValue([cell(), cell({ marketplace: 'DE' }), fresh()], read, NOW)!
    expect(mixed).toMatchObject({ quiet: 'Partial update', aside: '1 new' })
    expect(mixed.tooltip).toContain('Amazon · FR: Full update (a new listing, sent whole).')
    const allNew = sharedActionValue([fresh(), fresh({ marketplace: 'PL' })], read, NOW)!
    expect(allNew).toMatchObject({ pill: { label: 'Full update', tone: 'info', glyph: 'none' }, common: null, notOnChannel: true })
    expect(parseSharedSendInput(allNew)).toEqual({ skip: true })
    expect(sharedActionEditorOptions([fresh(), fresh({ marketplace: 'PL' })], true).map(o => [o.value, Boolean(o.heldReason)]))
      .toEqual([['partial', true], ['full', false], ['delete', true]])
  })
})

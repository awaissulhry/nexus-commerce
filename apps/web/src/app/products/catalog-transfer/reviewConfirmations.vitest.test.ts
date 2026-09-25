import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { appendConfirmations, applyRequest, deleteKey, deleteName, hasReadyRecords, recheckConfirmations, linkChoices, mergeConfirmations, NO_CONFIRMATIONS, ONE_LISTING_AT_A_TIME, toggleDelete, toggleLink } from './reviewConfirmations'
import { ChannelFileCounts, ReviewConfirmations } from './TransferReview'
import type { TransferJob } from './sourceMapping'

/** Measured case (L3-5): MISANO IT — three eBay parents proposed for ONE Nexus product with one listing. */
const misano = [
  { fileSku: 'MISANO-JACKET', proposedSku: '3K-HP05-BH9I', reason: '5 of 5 variation SKUs under MISANO-JACKET belong to 3K-HP05-BH9I' },
  { fileSku: 'MISANO-JACKET-ALT1', proposedSku: '3K-HP05-BH9I', reason: '5 of 5 variation SKUs under MISANO-JACKET-ALT1 belong to 3K-HP05-BH9I' },
  { fileSku: 'MOSS-JACKET', proposedSku: 'IT-MOSS-JACKET', reason: 'children belong to IT-MOSS-JACKET' },
]
const job = (over: Partial<TransferJob>): TransferJob => ({ jobId: 'j', state: 'QUEUED', processed: 0, total: 3, mode: 'upsert', filename: 'MISANO IT.xlsx', expiresAt: '', warnings: [],
  counts: { productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 0, refused: 0 }, reviewToken: 'token-1', ...over })

describe('confirming file SKU links', () => {
  it('allows one proposal per Nexus product and names why the next one waits', () => {
    let selected = toggleLink(misano, {}, 'MISANO-JACKET')
    expect(selected).toEqual({ 'MISANO-JACKET': '3K-HP05-BH9I' })
    const choices = linkChoices(misano, selected)
    expect(choices.map(c => [c.checked, c.disabled])).toEqual([[true, false], [false, true], [false, false]])
    expect(choices[1].reason).toBe(ONE_LISTING_AT_A_TIME)
    // A blocked proposal cannot be ticked around the disabled control.
    expect(toggleLink(misano, selected, 'MISANO-JACKET-ALT1')).toEqual(selected)
    // A different Nexus product is independent.
    selected = toggleLink(misano, selected, 'MOSS-JACKET')
    expect(selected).toEqual({ 'MISANO-JACKET': '3K-HP05-BH9I', 'MOSS-JACKET': 'IT-MOSS-JACKET' })
    // Unticking releases the product for the other proposal.
    selected = toggleLink(misano, selected, 'MISANO-JACKET')
    expect(linkChoices(misano, selected)[1].disabled).toBe(false)
  })

  it('keeps earlier confirmations when the file is checked again and sends them as the routes read them', () => {
    const first = mergeConfirmations(NO_CONFIRMATIONS, { 'MOSS-JACKET': 'IT-MOSS-JACKET' }, [], [])
    const second = mergeConfirmations(first, {}, ['GALE-JACKET-BLACK-MEN-M'], ['GALE-JACKET-BLACK-MEN-M'])
    expect(second).toEqual({ links: { 'MOSS-JACKET': 'IT-MOSS-JACKET' }, confirmDeletes: ['GALE-JACKET-BLACK-MEN-M'] })
    const body = appendConfirmations(new FormData(), second)
    expect(JSON.parse(String(body.get('links')))).toEqual({ 'MOSS-JACKET': 'IT-MOSS-JACKET' })
    expect(JSON.parse(String(body.get('confirmDeletes')))).toEqual(['GALE-JACKET-BLACK-MEN-M'])
    const empty = appendConfirmations(new FormData(), NO_CONFIRMATIONS)
    expect(empty.has('links')).toBe(false)
    expect(empty.has('confirmDeletes')).toBe(false)
  })

  it('confirms only deletes the Owner saw listed and ticked — a delete revealed later stays pending', () => {
    // Check 1: one delete is listed; the Owner ticks it and a link. A tick for a SKU never listed is dropped.
    const shown1 = ['GALE-JACKET-BLACK-MEN-M']
    expect(toggleDelete(shown1, [], 'NEVER-LISTED')).toEqual([])
    const after1 = mergeConfirmations(NO_CONFIRMATIONS, { 'MOSS-JACKET': 'IT-MOSS-JACKET' }, ['GALE-JACKET-BLACK-MEN-M', 'NEVER-LISTED'], shown1)
    expect(after1.confirmDeletes).toEqual(['GALE-JACKET-BLACK-MEN-M'])
    // Check 2: the confirmed link reveals a second delete (hidden behind the link before). Re-checking for
    // another reason must NOT carry a confirmation for it — it was never ticked.
    const after2 = mergeConfirmations(after1, { 'MISANO-JACKET': '3K-HP05-BH9I' }, [], ['MOSS-JACKET-YELLOW-MEN-S'])
    expect(after2.confirmDeletes).toEqual(['GALE-JACKET-BLACK-MEN-M'])
    const body = appendConfirmations(new FormData(), after2)
    expect(body.get('confirmDeletes')).not.toBe('true')
    expect(JSON.parse(String(body.get('confirmDeletes')))).toEqual(['GALE-JACKET-BLACK-MEN-M'])
  })
})

describe('saving the ready records of a review that also needs correction', () => {
  it('is offered only for an INVALID review with something to save', () => {
    expect(hasReadyRecords(job({ state: 'INVALID', counts: { productsCreated: 0, listingsCreated: 0, changed: 12, unchanged: 0, refused: 4 } }))).toBe(true)
    expect(hasReadyRecords(job({ state: 'INVALID', counts: { productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 5, refused: 4, pricesRecorded: 3 } }))).toBe(true)
    expect(hasReadyRecords(job({ state: 'INVALID', counts: { productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 5, refused: 4 } }))).toBe(false)
    expect(hasReadyRecords(job({ state: 'QUEUED', counts: { productsCreated: 0, listingsCreated: 0, changed: 12, unchanged: 0, refused: 0 } }))).toBe(false)
  })
  it('asks the server to skip refused records only when the Owner chose that', () => {
    expect(applyRequest(job({}), true)).toEqual({ reviewToken: 'token-1', readyOnly: true })
    expect(applyRequest(job({}), false)).toEqual({ reviewToken: 'token-1' })
    expect('readyOnly' in applyRequest(job({}), false)).toBe(false)
  })
})

const panel = (props: Partial<Parameters<typeof ReviewConfirmations>[0]>) => renderToStaticMarkup(createElement(ReviewConfirmations, {
  job: job({}), busy: false, canRecheck: true, confirmed: NO_CONFIRMATIONS, selectedLinks: {}, onLinks: () => {}, endSkus: [], onEndSkus: () => {}, onRecheck: () => {}, ...props,
}))

describe('the confirmation panel', () => {
  it('shows each proposal, the waiting reason, and the recheck button', () => {
    const html = panel({ job: job({ state: 'INVALID', links: misano }), selectedLinks: { 'MISANO-JACKET': '3K-HP05-BH9I' } })
    expect(html).toContain('File parent MISANO-JACKET → Nexus 3K-HP05-BH9I')
    expect(html).toContain(ONE_LISTING_AT_A_TIME)
    expect(html).toContain('Check the file again with these links')
  })
  it('lists unconfirmed deletes with their evidence and says nothing is sent', () => {
    const deletes = [{ fileSku: 'MOSS-JACKET-YELLOW-MEN-S', sku: 'IT-MOSS-JACKET-YELLOW-MEN-S', channel: 'AMAZON', marketplace: 'DE', accountId: 'a', evidence: 'Amazon last reported this listing on 2026-09-24', confirmed: false }]
    const html = panel({ job: job({ state: 'INVALID', deletes }), endSkus: ['MOSS-JACKET-YELLOW-MEN-S'] })
    expect(html).toContain('The file deletes 1 listing on the channel')
    expect(html).toContain('Amazon last reported this listing on 2026-09-24')
    // Named and ticked by the FILE's SKU; the Nexus SKU beside it.
    expect(html).toContain('Mark MOSS-JACKET-YELLOW-MEN-S (Nexus IT-MOSS-JACKET-YELLOW-MEN-S) · Amazon DE ended in Nexus')
    expect(html).toMatch(/type="checkbox" checked=""/)
    // A tick recorded under the Nexus SKU is not a confirmation of this delete.
    expect(panel({ job: job({ state: 'INVALID', deletes }), endSkus: ['IT-MOSS-JACKET-YELLOW-MEN-S'] })).toMatch(/<button[^>]*disabled=""[^>]*>Check the file again/)
    expect(html).toContain('Nothing is sent to Amazon or eBay.')
    expect(html).toContain('Check the file again with these ended listings')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Check the file again/)
    // A stale tick for a SKU no longer listed as pending does not count as a confirmation.
    expect(panel({ job: job({ state: 'INVALID', deletes }), endSkus: ['OTHER-SKU'] })).toMatch(/<button[^>]*disabled=""[^>]*>Check the file again/)
  })
  it('summarises confirmed deletes and never offers a recheck without the file', () => {
    const html = panel({ job: job({ deletes: [{ fileSku: 'X-FILE', sku: 'X', channel: 'EBAY', marketplace: 'IT', accountId: 'e', confirmed: true }, { fileSku: 'Y', sku: 'Y', channel: 'AMAZON', marketplace: 'FR', accountId: 'a', confirmed: true }], links: misano.slice(2) }), canRecheck: false })
    expect(html).toContain('2 listings will be marked ended in Nexus')
    // WHICH listings, not only a count.
    expect(html).toContain('X-FILE (Nexus X) · eBay IT')
    expect(html).toContain('<li>Y · Amazon FR</li>')
    expect(html).toContain('upload the same file again')
    expect(html).not.toContain('Check the file again')
  })
  it('renders nothing when the file needs no confirmation', () => {
    expect(panel({})).toBe('')
  })
})

describe('checking the file again', () => {
  it('sends the ticked pending deletes by FILE SKU, never the Nexus SKU', () => {
    const review = { deletes: [{ fileSku: 'MOSS-JACKET-S', sku: 'IT-MOSS-JACKET-S', channel: 'AMAZON', marketplace: 'DE', accountId: 'a', confirmed: false }] }
    expect(recheckConfirmations(NO_CONFIRMATIONS, {}, ['MOSS-JACKET-S'], review).confirmDeletes).toEqual(['MOSS-JACKET-S'])
    expect(recheckConfirmations(NO_CONFIRMATIONS, {}, ['IT-MOSS-JACKET-S'], review).confirmDeletes).toEqual([])
  })
})

describe('naming a delete', () => {
  it('keys and names it by the file SKU, the Nexus SKU only when different', () => {
    const d = { fileSku: 'MOSS-JACKET-S', sku: 'IT-MOSS-JACKET-S', channel: 'AMAZON', marketplace: 'DE', accountId: 'a', confirmed: false }
    expect(deleteKey(d)).toBe('AMAZON:DE:MOSS-JACKET-S')
    expect(deleteName(d, c => c)).toBe('MOSS-JACKET-S (Nexus IT-MOSS-JACKET-S) · AMAZON DE')
    expect(deleteName({ ...d, sku: 'MOSS-JACKET-S' }, c => c)).toBe('MOSS-JACKET-S · AMAZON DE')
  })
})

describe('channel-file totals', () => {
  it('names what the channel file does beyond attribute changes', () => {
    const html = renderToStaticMarkup(createElement(ChannelFileCounts, { counts: { productsCreated: 0, listingsCreated: 0, changed: 1, unchanged: 0, refused: 0, cleared: 3, alreadyEmpty: 7, ended: 1, pricesRecorded: 21 } }))
    expect(html).toContain('3 values Amazon removed — cleared in Nexus')
    expect(html).toContain('7 removed values already empty in Nexus')
    expect(html).toContain('1 listing to mark ended')
    expect(html).toContain('21 prices recorded, not sent')
    expect(renderToStaticMarkup(createElement(ChannelFileCounts, { counts: { productsCreated: 0, listingsCreated: 0, changed: 1, unchanged: 0, refused: 0 } }))).toBe('')
  })
})

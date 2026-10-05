/**
 * Review 2026-10-05 — the toolbar mark's pure parts: the destination's aliases come from the shared publish-actions read
 * (offered aliases only, by position), and a selling-change re-read asks again only for the listing still sending (m2).
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import { destinationAliases, listingsStillSending } from './usePublicationStatus'

const cell = (over: Partial<PublishActionCell>): PublishActionCell => ({
  listingId: 'cl-main', productId: 'fam', sku: 'FAM', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '', aliasLabel: null, aliasPosition: null, aliasStatus: null,
  state: 'active', stateReason: null,
  send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
  status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
  sendOptions: [], statusOptions: [], ...over,
})

describe('the toolbar mark’s aliases', () => {
  it('names the offered aliases of this destination only, in their place order', () => {
    const cells = [
      cell({}),
      cell({ listingId: 'cl-2', aliasKey: 'a2', aliasLabel: 'Second', aliasPosition: 2, aliasStatus: 'ACTIVE' }),
      cell({ listingId: 'cl-1', aliasKey: 'a1', aliasLabel: 'First', aliasPosition: 1, aliasStatus: 'ACTIVE' }),
      cell({ listingId: 'cl-3', aliasKey: 'a3', aliasLabel: 'Archived', aliasPosition: 3, aliasStatus: 'ARCHIVED' }),
      cell({ listingId: 'cl-de', marketplace: 'DE', aliasKey: 'de', aliasLabel: 'Elsewhere', aliasPosition: 1, aliasStatus: 'ACTIVE' }),
    ]
    expect(destinationAliases(cells, 'fam', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }).map(a => [a.id, a.label, a.position]))
      .toEqual([['a1', 'First', 1], ['a2', 'Second', 2]])
  })
})

describe('m2 — the "Last publish" re-read while a selling change is sent', () => {
  const now = Date.parse('2026-10-05T20:10:00.000Z')
  const read = (kind: string | null, status: string) => ({
    rows: [{ productId: 'fam', listingId: 'cl', last: kind ? { kind, status, at: '2026-10-05T20:08:00.000Z' } : null }],
  }) as unknown as StudioPublicationStatus
  const reads: Record<string, StudioPublicationStatus | null> = { '': read('publish', 'ACCEPTED'), a1: read('pause', 'PUBLISHING'), a2: read('end', 'ACCEPTED'), a3: null }

  it('reads again only the listing whose selling change is still on its way, never every listing', () => {
    expect(listingsStillSending(['', 'a1', 'a2', 'a3'], listing => reads[listing] ?? null, now)).toEqual(['a1'])
    // Everything settled (a last tick after it): nothing is read again.
    expect(listingsStillSending(['', 'a2'], listing => reads[listing] ?? null, now)).toEqual([])
  })
})

import { expect, it } from 'vitest'
import { publicationDestinations, matchesPublicationReview, retainPublicationReceipt, publicationOverwriteAcknowledged } from './model'
import type { StudioPublishResult, StudioPublishReview } from '@nexus/shared/studio-publication'

const market = { id: 'a', channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', language: 'it', accounts: [{ id: 'one', label: 'One', primary: true }, { id: 'two', label: 'Two', primary: false }] }
it('requires overwrite confirmation for the exact current review and refuses missing warning evidence', () => {
  const review: StudioPublishReview = { id: 'review-a', productId: 'p', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'one' },
    accountLabel: 'One', aliasLabel: 'Primary', mode: 'live', action: 'update', rows: [{ productId: 'p', sku: 'P', title: 'Product', existing: true }],
    excluded: 0, issues: [], expiresAt: '2026-09-25T12:00:00Z', overwrite: { requiresConfirmation: true, products: [] } }
  expect(publicationOverwriteAcknowledged(review, null)).toBe(false)
  expect(publicationOverwriteAcknowledged(review, 'review-b')).toBe(false)
  expect(publicationOverwriteAcknowledged(review, 'review-a')).toBe(true)
  expect(publicationOverwriteAcknowledged({ ...review, id: 'review-b' }, 'review-a')).toBe(false)
  expect(publicationOverwriteAcknowledged({ ...review, overwrite: undefined }, 'review-a')).toBe(false)
  expect(publicationOverwriteAcknowledged({ ...review, overwrite: undefined, rows: review.rows.map(r => ({ ...r, existing: false })) }, null)).toBe(true)
})
it('keeps a selected alias only in its exact account and marketplace', () => {
  const current = { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'alias' }
  const options = publicationDestinations([market, { ...market, id: 'de', code: 'DE' }], current)
  expect(options.map(o => o.scope.listingId)).toEqual([undefined, 'alias', undefined, undefined])
  expect(new Set(options.map(o => o.key)).size).toBe(4)
})
it('excludes disconnected destinations and deduplicates discovery rows', () => {
  expect(publicationDestinations([market, market, { ...market, id: 'de', code: 'DE', connected: false }])).toHaveLength(2)
})
it('rejects stale replies from another product, account, market or listing', () => {
  const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'alias' }
  const review = { id: 'r', productId: 'p', scope, rows: [], issues: [], expiresAt: '2026-09-13T23:00:00Z' }
  expect(matchesPublicationReview(review, 'p', scope)).toBe(true)
  for (const wrong of [{ ...scope, accountId: 'one' }, { ...scope, marketplace: 'DE' }, { ...scope, listingId: 'different' }]) expect(matchesPublicationReview(review, 'p', wrong)).toBe(false)
  expect(matchesPublicationReview(review, 'other', scope)).toBe(false)
})

it('keeps an acknowledged receipt visible when status has not recorded it yet', () => {
  const receipt: StudioPublishResult = { id: 'publish-1', status: 'UNVERIFIED', message: 'Keep this reference.', warnings: ['Channel warning'],
    results: [{ sku: 'A', status: 'ACCEPTED', reference: '123', message: 'Acknowledged' }] }
  for (const status of ['PUBLISHING', 'UNVERIFIED'] as const) {
    const next: StudioPublishResult = { id: receipt.id, status, message: 'Check again.', results: [] }
    const retained = retainPublicationReceipt(receipt, next)
    expect(retained).toMatchObject({ status, results: receipt.results, warnings: receipt.warnings })
    expect(retained.message).toContain('123')
  }
  const processed: StudioPublishResult = { id: receipt.id, status: 'FAILED', message: 'Rejected', results: [{ sku: 'A', status: 'FAILED', message: 'Invalid field', reference: '123' }] }
  expect(retainPublicationReceipt(receipt, processed)).toBe(processed)
  const different = { ...processed, id: 'publish-2', results: [] }
  expect(retainPublicationReceipt(receipt, different)).toBe(different)
})

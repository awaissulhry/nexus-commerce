import { expect, it } from 'vitest'
import { listingStatusMeta, LISTING_STATUSES } from './listingStatus'
it('normalises provider case without claiming channel verification', () => {
 for (const raw of ['ACTIVE','Active','active',' LIVE ']) expect(listingStatusMeta(raw)).toMatchObject({ label: 'Listed', tone: 'info' })
 expect(listingStatusMeta('Completed').label).toBe('Ended')
 expect(listingStatusMeta('ARCHIVED').label).toBe('Archived')
 expect(listingStatusMeta('future-token')).toMatchObject({ label: 'future-token', tone: 'neutral' })
 expect(listingStatusMeta(null).label).toBe('Not recorded')
 for (const s of LISTING_STATUSES) expect(listingStatusMeta(s).tone).not.toBe('success')
})

// The contract with the API's writers (it walks apps/api/src) lives in the web, outside this package:
// apps/web/src/lib/listing-status-api-writers.vitest.test.ts

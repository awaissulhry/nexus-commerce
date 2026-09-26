import type { PoolClient } from 'pg'
import { withQuarantineSnapshot } from './quarantine-snapshot.js'

const COUNTS = ['notices', 'deliveries', 'unresolved', 'reviewRequired', 'legacyReason', 'otherReason'] as const
type CensusRow = Record<typeof COUNTS[number], number> & { environment: 'production' | 'sandbox'; oldestReceivedAt: Date | null }
export class EbayDeletionCensusError extends Error {
  constructor(readonly code: 'authority_denied' | 'census_failed') {
    super('The eBay deletion census could not be completed.'); this.name = 'EbayDeletionCensusError'
  }
}

/** Existing dedicated metadata authority only. Never decrypts, assigns an owner or claims erasure. */
export async function readEbayDeletionCensus(client: Pick<PoolClient, 'query'>) {
  try {
    return await withQuarantineSnapshot(client, async asOf => {
      const { rows } = await client.query<CensusRow>('SELECT * FROM public.nexus_ebay_deletion_quarantine_census()')
      if (rows.length !== 2 || rows[0].environment !== 'production' || rows[1].environment !== 'sandbox'
        || rows.some(row => COUNTS.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)
          || row.notices !== row.reviewRequired + row.legacyReason + row.otherReason)) throw new EbayDeletionCensusError('census_failed')
      return { scope: 'verified_ebay_account_deletion_quarantine' as const, asOf, snapshotComplete: true as const,
        disposition: 'review_required_no_erasure' as const,
        byEnvironment: rows.map(row => ({ environment: row.environment, notices: row.notices, deliveries: row.deliveries,
          unresolved: row.unresolved, reviewRequired: row.reviewRequired, legacyReason: row.legacyReason, otherReason: row.otherReason,
          oldestReceivedAt: row.oldestReceivedAt?.toISOString() ?? null })) }
    })
  } catch (error) {
    throw new EbayDeletionCensusError((error as { code?: string } | null)?.code === '42501' ? 'authority_denied' : 'census_failed')
  }
}

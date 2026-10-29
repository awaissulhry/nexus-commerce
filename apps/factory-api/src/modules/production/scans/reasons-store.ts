import { W1_SCAN_REASONS, type DefectKind, type ScanReason } from '@nexus/factory-domain/production/scans/reasons'
import type { Reader } from './store'

/**
 * THE seam of the scrap and rework reasons (B-W1-42): the only place the scan rules and the screens get them from.
 *
 * INTERIM (until the schema step, the lead's SCHEMA token): factory-domain's fixed W1 list, the same for every tenant.
 * Then: the seeded ScrapReason table (tenant, kind, code, labels it/en, sort order, active), read in the caller's scope,
 * so W2a's "Floor rules & codes" edits rows, not code. The signature stays.
 */
export async function readReasons(_db: Reader, filter: { readonly kind?: DefectKind; readonly includeInactive?: boolean } = {}): Promise<ScanReason[]> {
  return W1_SCAN_REASONS.filter((reason) => (filter.kind === undefined || reason.kind === filter.kind) && (filter.includeInactive || reason.active)).sort((a, b) =>
    a.kind === b.kind ? a.sortOrder - b.sortOrder : a.kind === 'SCRAP' ? -1 : 1,
  )
}

import { FISCAL_TYPES } from './fiscal'
import { INQUIRY_TYPES } from './inquiries'
import { PLATFORM_TYPES } from './platform'
import type { RetentionType } from './type'

/**
 * The record types a retention rule may name (B-W2b-405; PLT-204): ONE LINE PER FILE of types (a step that adds record types
 * adds its file here). A rule naming a table outside this list only reports that the sweep knows nothing of it; the append-only
 * ledgers are never here (APPEND_ONLY_LEDGERS: never purged, the Owner's decision of 15 Nov 2026).
 */
export const RETENTION_TYPES: readonly RetentionType[] = [
  ...PLATFORM_TYPES,
  ...FISCAL_TYPES,
  // B-TH-053: the prospects of closed requests.
  ...INQUIRY_TYPES,
]

const BY_TYPE = new Map(RETENTION_TYPES.map((type) => [type.recordType, type]))

export const retentionTypeOf = (recordType: string): RetentionType | null => BY_TYPE.get(recordType) ?? null

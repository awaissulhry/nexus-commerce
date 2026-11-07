import { KIND_RULES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { CONCESSION_ADAPTER } from '../../modules/quality/ncr/concession-answer'
import { SIGNATURE_ADAPTER } from '../../modules/safety/risk/signature-link'
import { REACCEPTANCE_ADAPTER } from '../../modules/sales/orders/reacceptance'
import type { RecordAdapter } from './adapter'
import { PROOF_ADAPTER } from './proof'
import { SAMPLE_ADAPTERS } from './samples'

/**
 * What each record type shares when the office asks a partner to approve it (B-W2b-184): one adapter per record type, its
 * module's file where the module owns the record (quality: the concession; sales: the revised order; safety: the DVR
 * signature), this folder's for the records that only lend their thread (samples) and the made-to-measure proof. A kind
 * asked on a record type nobody registered is refused (fail closed); the registry checks at load that every pairing is one
 * the kinds allow (factory-domain approvals-out/kinds).
 */

const ADAPTERS: readonly RecordAdapter[] = Object.freeze([CONCESSION_ADAPTER, REACCEPTANCE_ADAPTER, SIGNATURE_ADAPTER, PROOF_ADAPTER, ...SAMPLE_ADAPTERS])

const byType = new Map<string, RecordAdapter>()
for (const adapter of ADAPTERS) {
  if (byType.has(adapter.recordType)) throw new Error(`Approval record ${adapter.recordType} is registered twice.`)
  for (const kind of adapter.kinds) if (!KIND_RULES[kind].recordTypes.includes(adapter.recordType)) throw new Error(`A ${kind} is not asked on a ${adapter.recordType}.`)
  byType.set(adapter.recordType, adapter)
}

/** The adapter of a record type for a kind, or undefined when that kind is not asked on it. */
export function adapterOf(kind: ApprovalKind, recordType: string): RecordAdapter | undefined {
  const adapter = byType.get(recordType)
  return adapter?.kinds.includes(kind) ? adapter : undefined
}

/** The adapter of a record type, whatever the kind (the office's list of a record's requests). */
export const adapterFor = (recordType: string): RecordAdapter | undefined => byType.get(recordType)

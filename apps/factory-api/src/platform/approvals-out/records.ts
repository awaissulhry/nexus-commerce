import { KIND_RULES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { CONCESSION_ADAPTER } from '../../modules/quality/ncr/concession-answer'
import { SIGNATURE_ADAPTER } from '../../modules/safety/risk/signature-link'
import { REACCEPTANCE_ADAPTER } from '../../modules/sales/orders/reacceptance'
// B-W2b-252: a sample round (SAMPLE) and a leather or colour swatch (COLOUR, LEATHER): the brand's answer is their decision.
import { SAMPLE_DECISION_ADAPTERS } from '../../modules/sales/sample-decisions/approvals'
import type { RecordAdapter } from './adapter'
import { PROOF_ADAPTER } from './proof'
import { SAMPLE_ADAPTERS } from './samples'
// B-PR-28: a new promise date asked of the customer (REPROMISE) joins the sales order's adapter (one adapter per record type).
import { withRepromise } from '../../modules/planning/promise-keep/brand-answer'
// B-PR-26: our counter-offer to a customer's request (COUNTER_OFFER), the change request's own adapter.
import { COUNTER_OFFER_ADAPTER } from '../../modules/sales/change-requests/counter'

/**
 * What each record type shares when the office asks a partner to approve it (B-W2b-184): one adapter per record type, its
 * module's file where the module owns the record (quality: the concession; sales: the revised order; safety: the DVR
 * signature), this folder's for the records that only lend their thread (samples) and the made-to-measure proof. A kind
 * asked on a record type nobody registered is refused (fail closed); the registry checks at its first use (fix-pr-10) that
 * every pairing is one the kinds allow (factory-domain approvals-out/kinds).
 */

// ── fix-pr-10: the registry is built at first use ───────────────────────────────────────────────────────────────────────────────
// Not while this module loads: B-PR-38's BRAND_OVERRIDE kind (platform/approvals/kinds) reads this registry, so the adapters'
// modules and this one are in one import cycle (sales/orders/reacceptance → amend → moves → the approvals engine → its kinds →
// brand-override → here → reacceptance). Entered from the sales side, an adapter's module is still loading when this module runs;
// at the first lookup every module is loaded. The checks (one adapter per record type, kinds its record allows) run then, once.
let registry: ReadonlyMap<string, RecordAdapter> | undefined

function byType(): ReadonlyMap<string, RecordAdapter> {
  if (registry) return registry
  const adapters: readonly RecordAdapter[] = [CONCESSION_ADAPTER, REACCEPTANCE_ADAPTER, SIGNATURE_ADAPTER, PROOF_ADAPTER, ...SAMPLE_ADAPTERS.map(withRepromise), ...SAMPLE_DECISION_ADAPTERS, COUNTER_OFFER_ADAPTER]
  const built = new Map<string, RecordAdapter>()
  for (const adapter of adapters) {
    if (built.has(adapter.recordType)) throw new Error(`Approval record ${adapter.recordType} is registered twice.`)
    // B-PR-28: the kinds only their own command asks are checked the same way.
    for (const kind of [...adapter.kinds, ...(adapter.commandKinds ?? [])]) if (!KIND_RULES[kind].recordTypes.includes(adapter.recordType)) throw new Error(`A ${kind} is not asked on a ${adapter.recordType}.`)
    built.set(adapter.recordType, adapter)
  }
  registry = built
  return built
}
// ── end fix-pr-10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The adapter of a record type for a kind, or undefined when that kind is not asked on it. */
export function adapterOf(kind: ApprovalKind, recordType: string): RecordAdapter | undefined {
  const adapter = byType().get(recordType)
  // B-PR-28: a kind its own command asks (REPROMISE) is read, answered and settled here too; "Ask for approval" offers `kinds` only.
  return adapter?.kinds.includes(kind) || adapter?.commandKinds?.includes(kind) ? adapter : undefined
}

/** The adapter of a record type, whatever the kind (the office's list of a record's requests). */
export const adapterFor = (recordType: string): RecordAdapter | undefined => byType().get(recordType)

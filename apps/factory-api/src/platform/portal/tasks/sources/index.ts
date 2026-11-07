import type { PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import { OFFICE_SOURCE } from './office'
import { PURCHASE_ORDERS_SOURCE } from './purchase-orders'
// B-W2b-177: a partner's document about to expire (UPLOAD_DOCUMENT, by the expiry reminder).
import { EXPIRY_SOURCE } from '../../../files/expiry/source'
// B-W2b-185: the request to pay each open invoice.
import { PAY_INVOICE_SOURCE } from '../../../../modules/payments/online/task-source'
import { SUBCONTRACT_JOBS_SOURCE } from './subcontract-jobs'
// B-W2b-189: a supplier's document refused by our check: upload it again.
import { SUPPLIER_DOCUMENT_SOURCE } from '../../../../modules/purchasing/portal-profile/task-source'
// B-W2b-184: the request to answer an approval (APPROVE, RECONFIRM_ORDER).
import { APPROVALS_SOURCE } from '../../../approvals-out/task-source'

/**
 * Where partner tasks come from (B-W2b-167, COL-043; plan W2b-3 "Sources"): one file per source in this folder, one line in
 * the list below (a merge point). A source is the command that makes a request of a partner; it opens the task IN that command
 * (`openTaskInCommand`, ../store.ts) with a `sourceKey` `<prefix>:<what>` (`PurchaseOrder:<id>:r<revision>`,
 * `ApprovalRequest:<id>`), and the command that takes the answer closes it (`closeTasksInCommand`). Home, the rail's badges
 * and the reminder e-mails read the same rows (../service.ts, ../reminders.ts).
 *
 * A source declares:
 *   name         for the audit row and the notes (`office`, later `purchasing.confirm`, `sales.quote`)
 *   prefix       the first word of its sourceKeys (one source per prefix: the registry refuses two)
 *   kinds        the kinds it opens
 *   partnerDone  the partner may mark its task done in the portal ("a safe verb runs in place with Undo"): a request with no
 *                answer of its own (a document we asked for by hand); false: only the answering command closes it
 */
export interface TaskSource {
  readonly name: string
  readonly prefix: string
  readonly kinds: readonly PartnerTaskKind[]
  readonly partnerDone: boolean
}

export const TASK_SOURCES: readonly TaskSource[] = Object.freeze([
  // B-W2b-167: what an office person asks a partner for by hand (a document, an answer, measurements, progress).
  OFFICE_SOURCE,
  // B-W2b-174: the supplier's request to confirm a purchase order we sent (one per revision).
  PURCHASE_ORDERS_SOURCE,
  // B-W2b-177: a document shared with the partner expires within 30 days: a new version, please.
  EXPIRY_SOURCE,
  // B-W2b-185: a PAY_INVOICE request per issued invoice while something is open on it (closed by the payment itself).
  PAY_INVOICE_SOURCE,
  // B-W2b-176: the workshop's requests on a job: confirm the kit we sent, report progress.
  SUBCONTRACT_JOBS_SOURCE,
  // B-W2b-189: a refused supplier document, asked again (closed by the supplier's next upload for it).
  SUPPLIER_DOCUMENT_SOURCE,
  // B-W2b-184: a partner's approval to give (a sample, a proof, a concession, a signature) or a revised order to re-confirm.
  APPROVALS_SOURCE,
])

const byPrefix = new Map<string, TaskSource>()
for (const source of TASK_SOURCES) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(source.prefix)) throw new Error(`Partner task source ${source.name}: its prefix is one word`)
  if (byPrefix.has(source.prefix)) throw new Error(`Partner task source ${source.name}: prefix ${source.prefix} is taken`)
  if (source.kinds.length === 0) throw new Error(`Partner task source ${source.name}: names the kinds it opens`)
  byPrefix.set(source.prefix, source)
}

/** The source of a sourceKey (`<prefix>:…`), or undefined when no declared source makes it. */
export function sourceOf(sourceKey: string): TaskSource | undefined {
  const prefix = sourceKey.split(':', 1)[0] ?? ''
  return byPrefix.get(prefix)
}

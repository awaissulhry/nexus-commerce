import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVOICES_ISSUE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { FilesRuntime } from '../../../platform/files/service'
import { officeContextOf, officeInvoice } from '../store'
import { assertCompany } from '../tax-codes/store'
import { copiesOfSends, copySend, readinessOf, sendStates } from './copy'

/**
 * The routes of our own copies (B-W2b-401; FIN-097; design finance.settings "Swap intermediary: our own copy of every XML and
 * receipt", finance.invoices record tab "Documents: SDI receipts"): a company's readiness to swap its intermediary with its
 * newest sends' copies, an invoice's copies, and "make the copies" for what is missing (invoices.issue, as "make the files":
 * our own fiscal-archive files, nothing is sent).
 */

const MAKE_PER_CALL = 100
const LIST_MAX = 200

/** invoices.view over the company: may it swap its intermediary now, and its newest sends' copies. */
export async function companyCopies(caller: CommandCaller, query: { companyId: string }) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_VIEW, { companyId: query.companyId }, 'Company')
  // The list names invoices: only those of the customers the caller sees; the readiness counts every send of the company.
  const invoice = { AND: [{ companyId: query.companyId }, scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput] }
  return caller.withClient(async (client) => ({ companyId: query.companyId, readiness: await readinessOf(client, query.companyId), sends: await copiesOfSends(client, { invoice }, LIST_MAX) }))
}

/** invoices.view: one invoice's sends and our copy of each. */
export async function invoiceCopies(caller: CommandCaller, invoiceId: string) {
  const invoice = await officeInvoice(caller, invoiceId)
  return { invoiceId: invoice.id, sends: await caller.withClient((client) => copiesOfSends(client, { invoiceId: invoice.id })) }
}

/** invoices.issue over the company: makes or completes the copies still missing, up to 100 sends per call (oldest first). */
export async function makeCopies(files: FilesRuntime, caller: CommandCaller, companyId: string) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_ISSUE, { companyId }, 'Company')
  const due = (await caller.withClient((client) => sendStates(client, companyId))).filter((send) => send.copy === 'MISSING' || send.copy === 'RECEIPTS_MISSING')
  let made = 0
  let completed = 0
  for (const send of due.slice(0, MAKE_PER_CALL)) {
    const changed = await copySend(files, caller, send.id)
    if (changed === 'made') made++
    if (changed === 'receipts') completed++
  }
  const readiness = await caller.withClient((client) => readinessOf(client, companyId))
  return { companyId, made, completed, remaining: readiness.missing, readiness }
}

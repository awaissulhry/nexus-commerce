import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_APPROVE } from '@nexus/factory-domain/payables/permissions'
import { DUAL_APPROVAL, dualThresholdMinor, FIRST_APPROVAL_LINE, needsSecondApproval, SECOND_APPROVAL_LINE, secondApprovalWords, thresholdText, type DualStep } from '@nexus/factory-domain/payables/proposal/approvals'
import { PROPOSAL_WORDS } from '@nexus/factory-domain/payables/proposal/rules'
import type { CommandCaller, CommandTools } from '../../core/command'
import { historyLine } from '../../platform/approvals/engine'
import { RefusedError } from './invoices'
import { mayOn, officeInvoice, peopleNames, RECORD, seesCost, type InvoiceRow, type Reader } from './store'

/**
 * Dual approval of a supplier invoice (B-W2b-403; FIN-142; design finance.payables record tab Approval "dual approval above
 * 10,000 (W2b)"): an invoice whose total is above the amount (factory-domain payables/proposal/approvals DUAL_APPROVAL) is
 * approved by two people. W2a's approve (approval.ts) calls `dualApprovalInCommand` inside its command, after its own
 * refusals (four eyes, the SDI rule, the receiver): the same separation of duties holds for both people.
 *
 *   the first yes   a REQUESTED line of the platform's approval history on the invoice (by the first approver), its audit row
 *                   `payables.approveFirst` with the version the command wrote, supplier_invoice.first_approved; the invoice
 *                   stays RECEIVED ("To approve")
 *   the second yes  by anyone else allowed: the APPROVED line (the database refuses it from the person of the last REQUESTED
 *                   line), then W2a's APPROVED as before. The first approver again: 409 refusal/SECOND_APPROVER
 *   a lapse         any write of the invoice after the first yes (its version moved: a line, a mapping, a dispute …) lapses
 *                   it: the next yes is a first again
 *
 *   GET /payables/invoices/:invoiceId/dual-approval   payables.view: needed, the amount (with the cost grain), the first yes
 *                                                    standing (who, when) or lapsed, whether the reader may give the next
 *                                                    yes and why not, in words
 */

export const FIRST_APPROVAL_ACTION = 'payables.approveFirst'

interface FirstYes {
  readonly byId: string
  readonly at: Date
  readonly version: number
}

/** The latest first yes of an invoice, and whether it still stands (the invoice is at the version it wrote). */
export async function firstYesOf(db: Reader, invoice: Pick<InvoiceRow, 'id' | 'version'>, version: number = invoice.version): Promise<{ first: FirstYes | null; standing: boolean }> {
  const row = await db.auditLog.findFirst({ where: { recordType: RECORD, recordId: invoice.id, action: FIRST_APPROVAL_ACTION }, select: { actorId: true, at: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  const after = (row?.after ?? null) as { version?: unknown } | null
  if (!row || !row.actorId || typeof after?.version !== 'number') return { first: null, standing: false }
  const first = { byId: row.actorId, at: row.at, version: after.version }
  return { first, standing: first.version === version }
}

export interface DualOutcome {
  readonly step: DualStep
  readonly firstById: string | null
}

/**
 * Inside W2a's approve command, after its refusals: SINGLE (at or below the amount, a credit note), FIRST (written here; the
 * caller leaves the invoice RECEIVED) or SECOND (the APPROVED history line written; the caller approves).
 */
export async function dualApprovalInCommand(tools: CommandTools, invoice: InvoiceRow, actorId: string): Promise<DualOutcome> {
  if (invoice.kind !== 'INVOICE' || !needsSecondApproval(invoice.grossTotal, invoice.currency)) return { step: 'SINGLE', firstById: null }
  // The version the command found (before its own bump): the first yes stands only if nothing wrote the invoice since.
  const found = tools.record?.previousVersion ?? invoice.version
  const { first, standing } = await firstYesOf(tools.tx, invoice, found)
  if (first && standing) {
    if (first.byId === actorId) throw new RefusedError([{ code: 'SECOND_APPROVER', message: PROPOSAL_WORDS.SECOND_APPROVER.en }])
    await historyLine(tools, { companyId: invoice.companyId, recordType: RECORD, recordId: invoice.id, action: 'APPROVED', byId: actorId, words: SECOND_APPROVAL_LINE })
    return { step: 'SECOND', firstById: first.byId }
  }
  await historyLine(tools, { companyId: invoice.companyId, recordType: RECORD, recordId: invoice.id, action: 'REQUESTED', byId: actorId, words: FIRST_APPROVAL_LINE })
  tools.audit({ action: FIRST_APPROVAL_ACTION, recordType: RECORD, recordId: invoice.id, companyId: invoice.companyId, before: { status: invoice.status }, after: { status: invoice.status, version: tools.record?.version ?? invoice.version, lapsed: first !== null } })
  tools.emit({ type: 'supplier_invoice.first_approved', subject: invoice.id, companyId: invoice.companyId, payload: { supplierInvoiceId: invoice.id, partyId: invoice.partyId, status: invoice.status as 'RECEIVED', matchStatus: invoice.matchStatus as 'MATCHED' } })
  return { step: 'FIRST', firstById: actorId }
}

/** GET /payables/invoices/:invoiceId/dual-approval */
export async function invoiceDualApproval(caller: CommandCaller, invoiceId: string) {
  const { context, invoice } = await officeInvoice(caller, invoiceId)
  return caller.withClient(async (client) => {
    const needed = invoice.kind === 'INVOICE' && needsSecondApproval(invoice.grossTotal, invoice.currency)
    const { first, standing } = needed ? await firstYesOf(client, invoice) : { first: null, standing: false }
    const names = await peopleNames(client, [first?.byId ?? null])
    const prices = seesCost(context)
    const open = invoice.status === 'RECEIVED'
    const mayApprove = mayOn(context, PAYABLES_APPROVE, invoice)
    const held: 'NOT_OPEN' | 'NO_PERMISSION' | 'SECOND_APPROVER' | null = !open ? 'NOT_OPEN' : !mayApprove ? 'NO_PERMISSION' : needed && standing && first?.byId === context.actorId ? 'SECOND_APPROVER' : null
    const firstName = first ? (names.get(first.byId) ?? null) : null
    return {
      invoiceId: invoice.id,
      needed,
      threshold: { amount: asMoney('cost', dualThresholdMinor(invoice.currency)), currency: invoice.currency, decided: DUAL_APPROVAL.decided, words: DUAL_APPROVAL.words },
      first: first ? { by: { id: first.byId, name: firstName }, at: toUtcIso(first.at), standing } : null,
      step: !needed ? ('SINGLE' as const) : standing ? ('SECOND' as const) : ('FIRST' as const),
      held,
      words: needed && standing ? secondApprovalWords(firstName, prices ? thresholdText(invoice.currency) : null) : null,
    }
  })
}

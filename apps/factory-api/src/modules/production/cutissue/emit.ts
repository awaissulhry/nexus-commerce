import type { CutIssueChange, RecutTicketChange, SecondaryProcessChange } from '@nexus/factory-domain/production-cutissue/events'
import type { CommandTools } from '../../../core/command'

/**
 * The events after the cut (B-W2b-117; factory-domain production-cutissue/events): one per change, in the command that makes it,
 * about the record's company and site (the Cutting page and the site's tablets). Ids, codes, states and counts only.
 */

type Scope = { readonly companyId: string; readonly siteId: string }

export function emitRecut(
  tools: Pick<CommandTools, 'emit'>,
  scope: Scope,
  ticket: { readonly id: string; readonly number: string; readonly status: string; readonly workOrderId: string; readonly workOrderSizeId: string; readonly bundleId: string | null; readonly quantity: number },
  workOrderNumber: string,
  change: RecutTicketChange,
  replacementId: string | null = null,
): void {
  tools.emit({
    type: 'recut_ticket.changed',
    subject: ticket.workOrderId,
    companyId: scope.companyId,
    siteId: scope.siteId,
    payload: {
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      workOrderId: ticket.workOrderId,
      number: workOrderNumber,
      workOrderSizeId: ticket.workOrderSizeId,
      bundleId: ticket.bundleId,
      ticketStatus: ticket.status,
      change,
      replacementId,
      quantity: ticket.quantity,
    },
  })
}

export function emitProcess(
  tools: Pick<CommandTools, 'emit'>,
  scope: Scope,
  process: { readonly id: string; readonly workOrderId: string; readonly bundleId: string; readonly kind: string; readonly place: string; readonly status: string; readonly workCentreId: string | null },
  workOrderNumber: string,
  change: SecondaryProcessChange,
): void {
  tools.emit({
    type: 'secondary_process.changed',
    subject: process.workOrderId,
    companyId: scope.companyId,
    siteId: scope.siteId,
    payload: {
      processId: process.id,
      workOrderId: process.workOrderId,
      number: workOrderNumber,
      bundleId: process.bundleId,
      kind: process.kind,
      place: process.place,
      processStatus: process.status,
      change,
      workCentreId: process.workCentreId,
    },
  })
}

export function emitIssue(
  tools: Pick<CommandTools, 'emit'>,
  issue: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly trolleyCode: string; readonly lineId: string; readonly status: string },
  change: CutIssueChange,
  facts: { readonly bundleId?: string | null; readonly workOrderIds: readonly string[]; readonly bundles: number; readonly missing?: number },
): void {
  tools.emit({
    type: 'cut_issue.changed',
    subject: issue.id,
    companyId: issue.companyId,
    siteId: issue.siteId,
    payload: {
      issueId: issue.id,
      trolleyCode: issue.trolleyCode,
      lineId: issue.lineId,
      issueStatus: issue.status,
      change,
      bundleId: facts.bundleId ?? null,
      workOrderIds: [...new Set(facts.workOrderIds)],
      bundles: facts.bundles,
      missing: facts.missing ?? 0,
    },
  })
}

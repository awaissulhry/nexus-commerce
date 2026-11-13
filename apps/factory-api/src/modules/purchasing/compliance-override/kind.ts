import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { OVERRIDE_REFUSALS } from '@nexus/factory-domain/purchasing/qualification/gate'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { SUPPLIER_STATUSES, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { events as qualificationEvents } from '@nexus/factory-domain/supplier-qualification/events'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from '../../../platform/approvals/kinds/kind'
import { readOrder } from '../store'
import { DECIDE_ACTION, gateAnswerOf, lockOrder, todayOf, WITHDRAW_ACTION } from '../qualification/store'
import { serverClock } from '../../../core/time'

/**
 * PURCHASE_ORDER_COMPLIANCE (B-W2b-377; follow-up XF5:02; SCM-022; B-W2b-315's override): "Send without a valid document?" is a
 * request of the approval engine, not a flag: it is listed in Home › Approvals, decided there or on the order, told to its
 * approvers, and its rules are written in Admin › Approval rules. modules/purchasing/compliance-override asks it in the ask's
 * command; when no switched-on rule holds, it is asked anyway of the office role that decides overrides (a second person's
 * yes is the gate's own rule), naming no rule.
 *
 *   facts      what holds the order at Send (how many requirements; a chromium VI test report, a PPE certificate, a company
 *              rule), the supplier's code and status, the site's code
 *   snapshot   the order (its revision and number) and the fingerprint of what holds it now (factory-domain gate
 *              holdFingerprint): a new line, another missing document or a document put in force before the yes makes it STALE
 *   yes        the gate lets the order go without that document (COMPLIANCE_OVERRIDDEN); the buyer sends it
 *   no / withdrawn / stale   the order stays held
 *
 * No money here; the decision's audit row and event keep B-W2b-315's names (purchasing.compliance.overrideDecide,
 * purchase_order.compliance_override_decided / _withdrawn).
 */

export const COMPLIANCE_KIND = 'PURCHASE_ORDER_COMPLIANCE' as const
const OVERRIDABLE: readonly string[] = ['DRAFT', 'PENDING_APPROVAL']
const [, , , , , , , decidedEvent, withdrawnEvent] = qualificationEvents

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const order = await readOrder(client, recordId)
  if (!order) return null
  const [party, site] = await Promise.all([
    client.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true, tradeName: true, supplierStatus: true } }),
    client.site.findUnique({ where: { id: order.siteId }, select: { code: true } }),
  ])
  const { answer } = await gateAnswerOf(client, order, todayOf(serverClock.now()))
  const name = party ? (party.tradeName ?? party.legalName) : ''
  const kinds = new Set(answer.blocks.map((entry) => entry.kind))
  const held = !OVERRIDABLE.includes(order.status) ? OVERRIDE_REFUSALS.notDraft : answer.blocks.length === 0 ? OVERRIDE_REFUSALS.nothingHeld : null
  return {
    companyId: order.companyId,
    siteId: order.siteId,
    label: `${order.number} · ${name}`.slice(0, 200),
    summary: `${order.number} to ${name}: to be sent without a valid document (${answer.blocks.length} held)`.slice(0, 500),
    facts: {
      heldCount: answer.blocks.length,
      crViTestReport: kinds.has('CR_VI_TEST_REPORT'),
      ppeCertificate: kinds.has('PPE_CERTIFICATE'),
      companyRule: kinds.has('RULE'),
      supplierCode: party?.code ?? null,
      supplierStatus: party?.supplierStatus ?? null,
      siteCode: site?.code ?? null,
    },
    // A draft and the same order waiting for its PO yes are one subject; what holds it is the gate's fingerprint.
    snapshot: { id: order.id, number: order.number, revision: order.revision, stage: OVERRIDABLE.includes(order.status) ? 'UNSENT' : order.status, holds: answer.fingerprint },
    changes: [{ field: 'status', from: order.status, to: 'SENT' }],
    held,
  }
}

/** The order the request is about, in the decision's command (its row locked by the engine through `lock`). */
async function orderOf(tools: CommandTools, task: TaskRef) {
  const order = await readOrder(tools.tx, task.recordId)
  return order ? { purchaseOrderId: order.id, number: order.number, partyId: order.partyId, companyId: order.companyId, siteId: order.siteId } : null
}

async function decided(tools: CommandTools, task: TaskRef, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const order = await orderOf(tools, task)
  if (!order) return
  tools.audit({ action: DECIDE_ACTION, recordType: 'PurchaseOrder', recordId: order.purchaseOrderId, companyId: order.companyId, siteId: order.siteId, after: { taskId: task.id, decision, decidedById: task.decidedById } })
  tools.emit(eventFor(decidedEvent, { subject: order.purchaseOrderId, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.purchaseOrderId, number: order.number, partyId: order.partyId, decision } }))
}

async function withdrawn(tools: CommandTools, task: TaskRef): Promise<void> {
  const order = await orderOf(tools, task)
  if (!order) return
  tools.audit({ action: WITHDRAW_ACTION, recordType: 'PurchaseOrder', recordId: order.purchaseOrderId, companyId: order.companyId, siteId: order.siteId, after: { taskId: task.id } })
  tools.emit(eventFor(withdrawnEvent, { subject: order.purchaseOrderId, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.purchaseOrderId, number: order.number, partyId: order.partyId } }))
}

const SUPPLIER_STATUS_LABELS: Readonly<Record<SupplierStatus, { readonly en: string; readonly it: string }>> = Object.freeze({
  PROSPECT: { en: 'Prospect', it: 'Potenziale' },
  APPROVED: { en: 'Approved', it: 'Approvato' },
  CONDITIONAL: { en: 'Conditional', it: 'Condizionato' },
  ON_HOLD: { en: 'On hold', it: 'Sospeso' },
  BLOCKED: { en: 'Blocked', it: 'Bloccato' },
  INACTIVE: { en: 'Inactive', it: 'Inattivo' },
})

const yesNo = (id: string, en: string, it: string): ApprovalField => ({ id, label: { en, it }, kind: 'yesNo' })

export const PURCHASE_ORDER_COMPLIANCE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: COMPLIANCE_KIND,
  recordType: 'PurchaseOrder',
  label: { en: 'Send without a valid document', it: 'Invio senza un documento valido' },
  view: PURCHASING_VIEW,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'heldCount', label: { en: 'documents missing', it: 'documenti mancanti' }, kind: 'number', unit: null, min: 0 },
    yesNo('crViTestReport', 'a chromium VI test report is missing', 'manca un rapporto di prova cromo VI'),
    yesNo('ppeCertificate', 'a protector certificate is missing', 'manca un certificato del protettore'),
    yesNo('companyRule', "a company rule's document is missing", "manca un documento chiesto da una regola dell'azienda"),
    { id: 'supplierCode', label: { en: 'supplier code', it: 'codice fornitore' }, kind: 'text' },
    {
      id: 'supplierStatus',
      label: { en: 'supplier status', it: 'stato del fornitore' },
      kind: 'choice',
      options: SUPPLIER_STATUSES.map((status) => ({ value: status, label: SUPPLIER_STATUS_LABELS[status] })),
    },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await lockOrder(tx, recordId)
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.purchaseOrder.findMany({ where: { ...(companyId ? { companyId } : {}), status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: (tools: CommandTools, task: TaskRef) => decided(tools, task, 'APPROVED'),
  onRejected: (tools: CommandTools, task: TaskRef) => decided(tools, task, 'REJECTED'),
  onWithdrawn: withdrawn,
  onStale: withdrawn,
})

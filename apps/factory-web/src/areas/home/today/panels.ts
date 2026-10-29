import { z } from 'zod'
import type { PanelRow } from './model'

/**
 * My lists (design home.today `role-panels`, W1): per role lens, the top five rows of the lists that role watches, each
 * a question, read from a module's EXISTING list route with its own filter (limit 6: a sixth row says there are more).
 * A panel shows when the person holds its route's permission and its lens is the one picked in the flow strip (a panel
 * without a lens always shows). Rows open their record (lib/records/record-links.ts); "See all" opens the list page once
 * one is built.
 *
 * Not built, because no list route serves them yet (design → report): lots on hold, inspections waiting, quotes that
 * expire in 3 days (no validity filter), shortages for released orders, work orders starting within 3 days (no due-date
 * range), deliveries due today, receipts due today, ships today, picks waiting, help calls, WIP stuck over 2 days,
 * styles without a declaration, label prints blocked, deposits to confirm, payments overdue.
 */

export interface PanelSource {
  readonly id: string
  /** The flow lens it belongs to (FLOW_LENSES), or null: shown whatever lens is picked. */
  readonly lens: string | null
  readonly permission: string
  /** The API list route and its filter. */
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  /** Reads one row of the answer; null drops a row the panel does not show. */
  readonly rows: (body: unknown) => readonly PanelRecordRow[]
}

/** A row before its link is made: the record it opens. */
export interface PanelRecordRow extends Omit<PanelRow, 'href'> {
  readonly record: { readonly type: string; readonly id: string; readonly label: string; readonly companyId: string | null; readonly siteId: string | null }
}

const list = <S extends z.ZodTypeAny>(key: string, row: S) => z.object({ [key]: z.array(row) }) as unknown as z.ZodType<Record<string, z.infer<S>[]>>

const quoteRow = z.object({ id: z.string(), number: z.string(), companyId: z.string(), partyName: z.string(), validUntil: z.string().nullable() })
const orderRow = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyName: z.string(),
  promiseDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  deposit: z.object({ state: z.string(), dueDate: z.string().nullable() }),
})
const workOrderRow = z.object({ id: z.string(), number: z.string(), companyId: z.string(), siteId: z.string(), styleCode: z.string(), dueDate: z.string().nullable(), daysLate: z.number().nullable() })
const purchaseRow = z.object({ id: z.string(), number: z.string(), companyId: z.string(), siteId: z.string(), supplierName: z.string(), sentAt: z.string().nullable(), requestedDate: z.string().nullable() })
const correctionRow = z.object({ id: z.string(), companyId: z.string(), siteId: z.string(), serverTime: z.string(), bundleCode: z.string(), workOrder: z.object({ number: z.string() }), operation: z.object({ name: z.string() }).passthrough() })
const invoiceRow = z.object({ id: z.string(), number: z.string().nullable(), companyId: z.string(), partyName: z.string(), issueDate: z.string().nullable() })
const entryRow = z.object({ id: z.string(), companyId: z.string(), reference: z.string(), reportedAt: z.string(), style: z.object({ code: z.string() }).nullable() })
const certificateRow = z.object({ id: z.string(), companyId: z.string().nullable(), number: z.string(), standard: z.string(), validTo: z.string(), daysToExpiry: z.number().nullable() })
const mailRow = z.object({ id: z.string(), companyId: z.string().nullable(), subject: z.string().nullable(), from: z.object({ address: z.string().nullable(), name: z.string().nullable() }), receivedAt: z.string(), status: z.string() })

/** The list's answer, or a thrown error (the panel then says it could not be read, never "nothing here"). */
export class PanelShapeError extends Error {
  override name = 'PanelShapeError'
}
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new PanelShapeError('The list answered in a shape this page does not know.')
  return parsed.data
}

export const PANELS: readonly PanelSource[] = Object.freeze<PanelSource[]>([
  {
    id: 'quotesToApprove',
    lens: 'ORDERS',
    permission: 'quotes.approve',
    path: '/sales/quotes',
    query: { status: 'PENDING_APPROVAL' },
    rows: (body) =>
      parse(list('quotes', quoteRow), body).quotes.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.partyName,
        word: { key: 'today.panels.word.waitsApproval' },
        date: row.validUntil,
        record: { type: 'Quote', id: row.id, label: row.number, companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'lateOrders',
    lens: 'ORDERS',
    permission: 'orders.view',
    path: '/sales/orders',
    query: { late: 'true' },
    rows: (body) =>
      parse(list('orders', orderRow), body).orders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.partyName,
        word: row.daysLate ? { key: 'today.panels.word.daysLate', params: { count: row.daysLate } } : null,
        date: row.promiseDate,
        record: { type: 'SalesOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'ordersWaitingDeposit',
    lens: 'ORDERS',
    permission: 'orders.view',
    path: '/sales/orders',
    query: { deposit: 'OPEN' },
    rows: (body) =>
      parse(list('orders', orderRow), body).orders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.partyName,
        word: { key: 'today.panels.word.depositOpen' },
        date: row.deposit.dueDate,
        record: { type: 'SalesOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'draftWorkOrders',
    lens: 'WORK_ORDERS',
    permission: 'workorders.release',
    path: '/production/work-orders',
    query: { status: 'DRAFT' },
    rows: (body) =>
      parse(list('workOrders', workOrderRow), body).workOrders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.styleCode,
        word: { key: 'today.panels.word.draft' },
        date: row.dueDate,
        record: { type: 'WorkOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId },
      })),
  },
  {
    id: 'lateWorkOrders',
    lens: 'WORK_ORDERS',
    permission: 'workorders.view',
    path: '/production/work-orders',
    query: { late: 'true' },
    rows: (body) =>
      parse(list('workOrders', workOrderRow), body).workOrders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.styleCode,
        word: row.daysLate ? { key: 'today.panels.word.daysLate', params: { count: row.daysLate } } : null,
        date: row.dueDate,
        record: { type: 'WorkOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId },
      })),
  },
  {
    id: 'scanCorrections',
    lens: 'WORK_ORDERS',
    permission: 'production.scan.correct',
    path: '/production/scans/corrections',
    query: { status: 'PENDING' },
    rows: (body) =>
      parse(list('requests', correctionRow), body).requests.map((row) => ({
        id: row.id,
        label: row.workOrder.number,
        sub: `${row.bundleCode} · ${row.operation.name}`,
        word: { key: 'today.panels.word.waitsDecision' },
        date: row.serverTime,
        record: { type: 'ScanCorrectionRequest', id: row.id, label: row.workOrder.number, companyId: row.companyId, siteId: row.siteId },
      })),
  },
  {
    id: 'posAwaitingSupplier',
    lens: 'PURCHASE_ORDERS',
    permission: 'purchasing.view',
    path: '/purchasing/orders',
    query: { status: 'SENT' },
    rows: (body) =>
      parse(list('orders', purchaseRow), body).orders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.supplierName,
        word: { key: 'today.panels.word.notConfirmed' },
        date: row.sentAt,
        record: { type: 'PurchaseOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId },
      })),
  },
  {
    id: 'supplierChanges',
    lens: 'PURCHASE_ORDERS',
    permission: 'purchasing.send',
    path: '/purchasing/orders',
    query: { status: 'CHANGES_PROPOSED' },
    rows: (body) =>
      parse(list('orders', purchaseRow), body).orders.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.supplierName,
        word: { key: 'today.panels.word.changesProposed' },
        date: row.requestedDate,
        record: { type: 'PurchaseOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId },
      })),
  },
  {
    id: 'sdiRefused',
    lens: 'INVOICES',
    permission: 'invoices.view',
    path: '/invoicing/invoices',
    query: { status: 'REJECTED' },
    rows: (body) =>
      parse(list('invoices', invoiceRow), body).invoices.map((row) => ({
        id: row.id,
        label: row.number ?? row.id.slice(0, 8),
        sub: row.partyName,
        word: { key: 'today.panels.word.sdiRejected' },
        date: row.issueDate,
        record: { type: 'Invoice', id: row.id, label: row.number ?? row.id.slice(0, 8), companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'registerOpen',
    lens: 'LOTS',
    permission: 'compliance.register.view',
    path: '/compliance/register',
    query: { status: 'OPEN' },
    rows: (body) =>
      parse(list('entries', entryRow), body).entries.map((row) => ({
        id: row.id,
        label: row.reference,
        sub: row.style?.code ?? null,
        word: { key: 'today.panels.word.open' },
        date: row.reportedAt,
        record: { type: 'PpeRegisterEntry', id: row.id, label: row.reference, companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'certificatesExpiring',
    lens: 'LOTS',
    permission: 'compliance.certificates.view',
    path: '/compliance/certificates',
    query: { expiringWithinDays: '90' },
    rows: (body) =>
      parse(list('certificates', certificateRow), body).certificates.map((row) => ({
        id: row.id,
        label: row.number,
        sub: row.standard,
        word: row.daysToExpiry !== null ? { key: 'today.panels.word.expiresIn', params: { count: row.daysToExpiry } } : null,
        date: row.validTo,
        record: { type: 'Certificate', id: row.id, label: row.number, companyId: row.companyId, siteId: null },
      })),
  },
  {
    id: 'mailToSort',
    lens: null,
    permission: 'email.triage',
    path: '/email/inbound',
    query: {},
    rows: (body) =>
      parse(list('mails', mailRow), body).mails.map((row) => {
        const sender = row.from.name?.trim() || row.from.address || ''
        const label = row.subject?.trim() || sender
        return {
          id: row.id,
          label,
          sub: sender || null,
          word: { key: `today.panels.word.mail.${row.status}` },
          date: row.receivedAt,
          record: { type: 'InboundEmail', id: row.id, label, companyId: row.companyId, siteId: null },
        }
      }),
  },
])

/** The panels this person sees with this lens picked. */
export function panelsFor(permissions: ReadonlySet<string>, lens: string | null): PanelSource[] {
  return PANELS.filter((panel) => permissions.has(panel.permission) && (panel.lens === null || panel.lens === lens))
}

/** The rows a panel shows (five) and whether more exist (a sixth came back). */
export const PANEL_ROWS = 5
export function panelPage<T>(rows: readonly T[]): { rows: T[]; more: boolean } {
  return { rows: rows.slice(0, PANEL_ROWS), more: rows.length > PANEL_ROWS }
}

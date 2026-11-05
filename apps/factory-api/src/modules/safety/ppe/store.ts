import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SAFETY_PPE_ISSUE, SAFETY_PPE_MANAGE } from '@nexus/factory-domain/safety/ppe/permissions'
import { receiptState, receiptsOf, type PpeCategory, type PpeIssueReason, type PpeReceiptMethod, type ReceiptState } from '@nexus/factory-domain/safety/ppe/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { workerGatesFor } from '../../people/privacy/worker-gate'
import { userNames } from '../../people/employees/employees'
import { nameOf } from '../../people/employees/store'
import { mayAt } from '../organisation/access'

/**
 * PPE for workers as the office reads it (B-W2b-134; design plant.ppe): the catalogue's items, the issue rows grouped into
 * receipts with their voids, scans and kept PDFs. One read per table; shared by the reads and the writes (their answers).
 *
 * A receipt = the ISSUE rows handed to one person at one site at the same instant with the same method (factory-domain
 * `receiptsOf`); its id is its smallest row id, the record its paper scan and its kept PDF are files of. A floor worker who
 * handed items over is named only where the site's PERFORMANCE gate is open (B-W2b-F3 `workerGatesFor`: who did something
 * at a tablet); the person who received is the receipt's subject and is always named (art. 77 c.4).
 */

type Client = FactoryClient | CommandTx

export const RECORD_ISSUE = 'PpeIssue'
export const RECEIPT_KIND = 'PPE_RECEIPT'

const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)

// ---- the catalogue ----------------------------------------------------------------------------------------------------------

export const ITEM_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  category: true,
  standard: true,
  sizes: true,
  lifeMonths: true,
  supplierPartyId: true,
  unitCost: true,
  status: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { code: true, legalName: true } },
  supplier: { select: { id: true, code: true, legalName: true, tradeName: true } },
  _count: { select: { kitLines: { where: { roleSheet: { status: 'ACTIVE' } } }, issues: { where: { kind: 'ISSUE' } } } },
} as const satisfies Prisma.PpeItemSelect
export type ItemRow = Prisma.PpeItemGetPayload<{ select: typeof ITEM_SELECT }>

export const readItem = (client: Client, id: string): Promise<ItemRow | null> => client.ppeItem.findUnique({ where: { id }, select: ITEM_SELECT }) as Promise<ItemRow | null>

/** An item as the catalogue lists it (the unit cost is the cost grain: the contract drops it without). */
export function itemView(context: OfficeContext, row: ItemRow) {
  const place = { companyId: row.companyId, siteId: null }
  return {
    id: row.id,
    companyId: row.companyId,
    company: { code: row.company.code, name: row.company.legalName },
    code: row.code,
    name: row.name,
    nameI18n: i18nOf(row.nameI18n),
    category: row.category as PpeCategory,
    standard: row.standard,
    sizes: row.sizes,
    lifeMonths: row.lifeMonths,
    supplier: row.supplier ? { id: row.supplier.id, code: row.supplier.code, name: row.supplier.tradeName ?? row.supplier.legalName } : null,
    unitCost: asMoney('cost', row.unitCost),
    status: row.status as 'ACTIVE' | 'ARCHIVED',
    note: row.note,
    /** ACTIVE role sheets whose kit names it; issues handed over (lines, voided ones too). */
    inKits: row._count.kitLines,
    issued: row._count.issues,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    canManage: mayAt(context, SAFETY_PPE_MANAGE, place),
  }
}

// ---- issues and receipts ----------------------------------------------------------------------------------------------------

export const ISSUE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  employeeId: true,
  ppeItemId: true,
  size: true,
  quantity: true,
  reason: true,
  issuedAt: true,
  issuedById: true,
  issuedByWorkerId: true,
  method: true,
  signedByWorkerId: true,
  deviceId: true,
  clientEventId: true,
  signatureSha256: true,
  voidsId: true,
  voidReason: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.PpeIssueSelect
export type IssueRow = Prisma.PpeIssueGetPayload<{ select: typeof ISSUE_SELECT }>

export interface IssueLineView {
  readonly id: string
  readonly receiptId: string
  readonly issuedAt: string
  readonly companyId: string
  readonly siteId: string
  readonly site: { readonly code: string; readonly name: string }
  readonly employee: { readonly id: string; readonly name: string; readonly employeeCode: string | null }
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly nameI18n: Record<string, string> | null; readonly category: string }
  readonly size: string | null
  readonly quantity: number
  readonly reason: PpeIssueReason
  readonly method: PpeReceiptMethod
  readonly issuedBy: { readonly kind: 'USER' | 'WORKER' | 'NONE'; readonly name: string | null; readonly hidden: boolean }
  readonly receipt: { readonly id: string; readonly state: ReceiptState; readonly scanFileId: string | null; readonly documentFileId: string | null }
  readonly device: { readonly id: string; readonly name: string } | null
  readonly voided: { readonly voidId: string; readonly at: string; readonly reason: string | null; readonly by: string | null } | null
  readonly canVoid: boolean
}

export interface ReceiptView {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly site: { readonly code: string; readonly name: string }
  readonly employee: { readonly id: string; readonly name: string; readonly employeeCode: string | null }
  readonly issuedAt: string
  readonly method: PpeReceiptMethod
  readonly state: ReceiptState
  readonly issuedBy: IssueLineView['issuedBy']
  readonly signature: { readonly workerId: string; readonly worker: string | null; readonly device: { readonly id: string; readonly name: string } | null; readonly sha256: string } | null
  readonly scan: { readonly fileId: string; readonly name: string } | null
  readonly document: { readonly id: string; readonly version: number; readonly language: string; readonly fileId: string; readonly createdAt: string } | null
  readonly lines: IssueLineView[]
  readonly units: number
  readonly canIssue: boolean
}

/**
 * The receipts of these ISSUE rows, with everything a screen shows: the person, the items, the voids, who handed them over (a
 * floor worker behind the site's gate), the device, the paper scan and the kept PDF. Rows of other kinds are ignored.
 */
export async function receiptViews(client: Client, context: OfficeContext, rows: readonly IssueRow[]): Promise<ReceiptView[]> {
  const issues = rows.filter((row) => row.kind === 'ISSUE')
  if (issues.length === 0) return []
  const groups = receiptsOf(issues)
  const receiptIds = groups.map((group) => group.receiptId)
  const issueIds = issues.map((row) => row.id)
  const voids = await client.ppeIssue.findMany({ where: { kind: 'VOID', voidsId: { in: issueIds } }, select: { id: true, voidsId: true, issuedAt: true, voidReason: true, createdById: true } })
  const people = await client.employee.findMany({ where: { id: { in: [...new Set(issues.map((row) => row.employeeId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
  const items = await client.ppeItem.findMany({ where: { id: { in: [...new Set(issues.map((row) => row.ppeItemId))] } }, select: { id: true, code: true, name: true, nameI18n: true, category: true } })
  const sites = await client.site.findMany({ where: { id: { in: [...new Set(issues.map((row) => row.siteId))] } }, select: { id: true, code: true, name: true } })
  const deviceIds = [...new Set(issues.map((row) => row.deviceId).filter((id): id is string => id !== null))]
  const devices = deviceIds.length > 0 ? await client.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } }) : []
  const documents = await client.generatedDocument.findMany({
    where: { recordType: RECORD_ISSUE, recordId: { in: receiptIds }, kind: RECEIPT_KIND },
    orderBy: [{ version: 'desc' }],
    select: { id: true, recordId: true, version: true, language: true, fileId: true, createdAt: true },
  })
  const kept = new Set(documents.map((document) => document.fileId))
  const files = (await client.storedFile.findMany({ where: { recordType: RECORD_ISSUE, recordId: { in: receiptIds }, status: 'AVAILABLE' }, orderBy: [{ createdAt: 'desc' }], select: { id: true, recordId: true, originalName: true } })).filter(
    (file) => !kept.has(file.id),
  )
  const gates = await workerGatesFor(client, issues.map((row) => row.siteId))
  const workerIds = [...new Set(issues.flatMap((row) => [row.issuedByWorkerId, row.signedByWorkerId]).filter((id): id is string => id !== null))]
  const workers = workerIds.length > 0 ? new Map((await client.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName])) : new Map<string, string>()
  const users = await userNames(client, [...issues.map((row) => row.issuedById), ...voids.map((row) => row.createdById)])

  const personOf = new Map(people.map((row) => [row.id, { id: row.id, name: nameOf(row), employeeCode: row.employeeCode }]))
  const itemOf = new Map(items.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, nameI18n: i18nOf(row.nameI18n), category: row.category as string }]))
  const siteOf = new Map(sites.map((row) => [row.id, { code: row.code, name: row.name }]))
  const deviceOf = new Map(devices.map((row) => [row.id, { id: row.id, name: row.name }]))
  const voidOf = new Map(voids.map((row) => [row.voidsId!, row]))

  return groups.map((group) => {
    const head = group.rows[0]!
    const place = { companyId: head.companyId, siteId: head.siteId }
    const gate = gates.at(head.siteId)
    const issuedBy: IssueLineView['issuedBy'] = head.issuedById
      ? { kind: 'USER', name: users.get(head.issuedById) ?? null, hidden: false }
      : head.issuedByWorkerId
        ? { kind: 'WORKER', name: gate.name(head.issuedByWorkerId, workers), hidden: gate.hidden(head.issuedByWorkerId) }
        : { kind: 'NONE', name: null, hidden: false }
    const scanFile = files.find((file) => file.recordId === group.receiptId) ?? null
    const document = documents.find((entry) => entry.recordId === group.receiptId) ?? null
    const voidedLines = group.rows.filter((row) => voidOf.has(row.id)).length
    const state = receiptState(head.method, voidedLines, group.rows.length, scanFile !== null)
    const canIssue = mayAt(context, SAFETY_PPE_ISSUE, place)
    const device = head.deviceId ? (deviceOf.get(head.deviceId) ?? null) : null
    const receipt = { id: group.receiptId, state, scanFileId: scanFile?.id ?? null, documentFileId: document?.fileId ?? null }
    const employee = personOf.get(head.employeeId) ?? { id: head.employeeId, name: '', employeeCode: null }
    const lines: IssueLineView[] = group.rows.map((row) => {
      const voided = voidOf.get(row.id)
      return {
        id: row.id,
        receiptId: group.receiptId,
        issuedAt: toUtcIso(row.issuedAt),
        companyId: row.companyId,
        siteId: row.siteId,
        site: siteOf.get(row.siteId) ?? { code: '', name: '' },
        employee,
        item: itemOf.get(row.ppeItemId) ?? { id: row.ppeItemId, code: '', name: '', nameI18n: null, category: '' },
        size: row.size,
        quantity: row.quantity,
        reason: row.reason as PpeIssueReason,
        method: row.method as PpeReceiptMethod,
        issuedBy,
        receipt,
        device,
        voided: voided ? { voidId: voided.id, at: toUtcIso(voided.issuedAt), reason: voided.voidReason, by: voided.createdById ? (users.get(voided.createdById) ?? null) : null } : null,
        canVoid: canIssue && !voided,
      }
    })
    return {
      id: group.receiptId,
      companyId: head.companyId,
      siteId: head.siteId,
      site: siteOf.get(head.siteId) ?? { code: '', name: '' },
      employee,
      issuedAt: toUtcIso(head.issuedAt),
      method: head.method as PpeReceiptMethod,
      state,
      issuedBy,
      signature:
        head.method === 'FLOOR_PIN' && head.signedByWorkerId && head.signatureSha256
          ? { workerId: head.signedByWorkerId, worker: workers.get(head.signedByWorkerId) ?? null, device, sha256: head.signatureSha256 }
          : null,
      scan: scanFile ? { fileId: scanFile.id, name: scanFile.originalName } : null,
      document: document ? { id: document.id, version: document.version, language: document.language, fileId: document.fileId, createdAt: toUtcIso(document.createdAt) } : null,
      lines,
      units: group.rows.filter((row) => !voidOf.has(row.id)).reduce((sum, row) => sum + row.quantity, 0),
      canIssue,
    }
  })
}

/** Every row of the receipt a row belongs to (its rows: same person, site, instant and method), or null. */
export async function receiptRowsOf(client: Client, issueId: string): Promise<IssueRow[] | null> {
  const row = await client.ppeIssue.findUnique({ where: { id: issueId }, select: ISSUE_SELECT })
  if (!row || row.kind !== 'ISSUE') return null
  return (await client.ppeIssue.findMany({
    where: { kind: 'ISSUE', siteId: row.siteId, employeeId: row.employeeId, issuedAt: row.issuedAt, method: row.method },
    orderBy: [{ id: 'asc' }],
    select: ISSUE_SELECT,
  })) as IssueRow[]
}

/** The person's (or people's) advisory lock: their receipts, the same-time check and the void-once read serialize on it. */
export async function lockPerson(tx: CommandTx, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ppe-issue', ${employeeId}::text), 0))`
}

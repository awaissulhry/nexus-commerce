import type { Uom } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { markValues, type RowIssue } from '@nexus/factory-domain/imports/importer'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { packingListImporter } from '@nexus/factory-domain/purchasing/ship-notices/importer'
import { blankText, placeHides } from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import type { ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { dayOf } from '../store'

/**
 * The packing list importer's adapter (factory-domain purchasing/ship-notices/importer; platform/imports; B-W2b-182,
 * SCM-107): the tannery mailed its list instead of using the portal, and our dock imports it onto the SENT notice it
 * belongs to (by the notice's number), with the engine's dry run first.
 *
 *   authorize  a company's import only (a notice is a company's).
 *   load       the hides the rows name already on their notice (by the tannery's number): the plan answers UNCHANGED or
 *              UPDATE (its area, grade …), never a second hide.
 *   check      every row against its notice: SENT (a draft is the supplier's, a received or cancelled one changes no more),
 *              of the job's company, at a site the person receives at (inventory.receive); a leather line of the notice
 *              (by the order line's number, or the notice's only leather line); an area unit.
 *   write      one hide per row (its place after the line's last), audited; `ship_notice.changed` (PACKING_LIST).
 *
 * Running and applying it needs inventory.receive (with imports.run / imports.apply); seeing its plans inventory.stock.view.
 */

const text = (value: CellValue | undefined | null): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

interface NoticeFacts {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly purchaseOrderId: string
  readonly expectedDate: Date | null
  readonly lines: readonly { readonly id: string; readonly orderSeq: number; readonly uom: Uom; readonly leather: boolean }[]
}

async function noticesByNumber(client: CommandTx, numbers: readonly string[], scope: ImportScope): Promise<Map<string, NoticeFacts>> {
  if (!scope.companyId || numbers.length === 0) return new Map()
  const rows = await client.shipNotice.findMany({
    where: { companyId: scope.companyId, number: { in: [...new Set(numbers)], mode: 'insensitive' } },
    select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, purchaseOrderId: true, expectedDate: true, lines: { select: { id: true, uom: true, purchaseOrderLine: { select: { seq: true, item: { select: { tracking: true } } } } } } },
  })
  return new Map(
    rows.map((row) => [
      row.number!.toUpperCase(),
      { ...row, number: row.number!, lines: row.lines.map((line) => ({ id: line.id, orderSeq: line.purchaseOrderLine.seq, uom: line.uom, leather: line.purchaseOrderLine.item.tracking === 'HIDE' })) },
    ]),
  )
}

const valuesOf = (notice: string, hide: { hideNumber: string; area: { toString(): string }; areaUom: Uom; grade: string | null; thicknessMm: { toString(): string } | null; dyeBatch: string | null; note: string | null }, orderSeq: number) => ({
  notice,
  hideNumber: hide.hideNumber,
  area: new Dec(hide.area.toString()).toString(),
  unit: hide.areaUom,
  line: orderSeq,
  grade: hide.grade,
  thicknessMm: hide.thicknessMm === null ? null : new Dec(hide.thicknessMm.toString()).toString(),
  dyeBatch: hide.dyeBatch,
  note: hide.note,
})

export const packingListImportAdapter: ImportAdapter = Object.freeze({
  importer: packingListImporter,
  permission: INVENTORY_RECEIVE,
  viewPermission: INVENTORY_STOCK_VIEW,
  authorize: (_actor, job) => (job.companyId === null ? [{ path: 'companyId', message: "A packing list goes on a ship notice of one company: import it as the notice's company." }] : []),
  async load(client, keys, scope) {
    const notices = await noticesByNumber(client, keys.map((key) => String(key.notice)), scope)
    if (notices.size === 0) return []
    const hides = await client.shipNoticeHide.findMany({
      where: { shipNoticeId: { in: [...notices.values()].map((notice) => notice.id) }, hideNumber: { in: keys.map((key) => String(key.hideNumber)) } },
      select: { id: true, shipNoticeId: true, shipNoticeLineId: true, hideNumber: true, area: true, areaUom: true, grade: true, thicknessMm: true, dyeBatch: true, note: true },
    })
    const byId = new Map([...notices.values()].map((notice) => [notice.id, notice]))
    return hides.map((hide) => {
      const notice = byId.get(hide.shipNoticeId)!
      return { id: hide.id, values: valuesOf(notice.number, hide, notice.lines.find((line) => line.id === hide.shipNoticeLineId)?.orderSeq ?? 0) }
    })
  },
  async check(client, rows, scope, actor) {
    const notices = await noticesByNumber(client, rows.map((row) => String(row.key.notice)), scope)
    return rows.map((row): RowIssue[] => {
      const notice = notices.get(String(row.key.notice).toUpperCase())
      if (!notice) return [{ column: 'notice', message: `Ship notice ${String(row.key.notice)} is not a notice of this company.` }]
      if (notice.status !== 'SENT') return [{ column: 'notice', message: `Ship notice ${notice.number} is ${notice.status.toLowerCase()}: only a sent notice takes the tannery's list here.` }]
      if (!can(actor, INVENTORY_RECEIVE, { companyId: notice.companyId, siteId: notice.siteId })) return [{ column: 'notice', message: `Receiving goods at the notice's site needs inventory.receive.` }]
      const leather = notice.lines.filter((line) => line.leather).map((line) => ({ id: line.id, orderSeq: line.orderSeq, uom: line.uom }))
      const placed = placeHides([{ line: typeof row.values.line === 'number' ? row.values.line : null, hideNumber: String(row.key.hideNumber), area: String(row.values.area ?? '1'), unit: (row.values.unit as Uom | undefined) ?? null }], leather, 'row')
      return placed.issues.map((issue) => ({ column: issue.path.split('/').at(-1), message: issue.message }))
    })
  },
  async write(tools, row, scope) {
    const { tx, now } = tools
    const notice = (await noticesByNumber(tx, [String(row.key.notice)], scope)).get(String(row.key.notice).toUpperCase())
    if (!notice || notice.status !== 'SENT') throw new Error(`Ship notice ${String(row.key.notice)} no longer takes its packing list.`)
    const leather = notice.lines.filter((line) => line.leather)
    const values = row.values
    if (row.action === 'CREATE') {
      const line = typeof values.line === 'number' ? leather.find((entry) => entry.orderSeq === values.line) : leather.length === 1 ? leather[0] : undefined
      if (!line) throw new Error(`Hide ${String(row.key.hideNumber)}: name the notice's leather line.`)
      const last = await tx.shipNoticeHide.aggregate({ where: { shipNoticeLineId: line.id }, _max: { seq: true } })
      const id = newId()
      await tx.shipNoticeHide.create({
        data: {
          id,
          siteId: notice.siteId,
          partyId: notice.partyId,
          shipNoticeId: notice.id,
          shipNoticeLineId: line.id,
          seq: (last._max.seq ?? 0) + 1,
          hideNumber: String(row.key.hideNumber).trim(),
          area: new Dec(String(values.area)).toFixed(4),
          areaUom: ((values.unit as Uom | undefined) ?? line.uom) as Uom,
          grade: text(values.grade),
          thicknessMm: values.thicknessMm === undefined ? null : String(values.thicknessMm),
          dyeBatch: text(values.dyeBatch),
          note: text(values.note),
          createdAt: now,
          updatedAt: now,
          createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
        select: { id: true },
      })
      tools.audit({ action: 'purchasing.importPackingListHide', recordType: 'ShipNotice', recordId: notice.id, companyId: notice.companyId, siteId: notice.siteId, after: { hideId: id, ...markValues(packingListImporter, values) } })
      tools.emit({ type: 'ship_notice.changed', subject: notice.id, companyId: notice.companyId, siteId: notice.siteId, payload: { shipNoticeId: notice.id, number: notice.number, purchaseOrderId: notice.purchaseOrderId, partyId: notice.partyId, status: 'SENT', what: 'PACKING_LIST', expectedDate: dayOf(notice.expectedDate) } })
      return { recordId: id }
    }
    const current = await tx.shipNoticeHide.findUniqueOrThrow({ where: { id: row.recordId! }, select: { id: true } })
    await tx.shipNoticeHide.update({
      where: { id: current.id },
      data: {
        ...(values.area !== undefined ? { area: new Dec(String(values.area)).toFixed(4) } : {}),
        ...(values.unit !== undefined ? { areaUom: values.unit as Uom } : {}),
        ...(values.grade !== undefined ? { grade: blankText(String(values.grade)) } : {}),
        ...(values.thicknessMm !== undefined ? { thicknessMm: String(values.thicknessMm) } : {}),
        ...(values.dyeBatch !== undefined ? { dyeBatch: blankText(String(values.dyeBatch)) } : {}),
        ...(values.note !== undefined ? { note: blankText(String(values.note)) } : {}),
        version: { increment: 1 },
      },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.importPackingListHide', recordType: 'ShipNotice', recordId: notice.id, companyId: notice.companyId, siteId: notice.siteId, before: markValues(packingListImporter, row.before), after: { hideId: current.id, ...markValues(packingListImporter, values) } })
    tools.emit({ type: 'ship_notice.changed', subject: notice.id, companyId: notice.companyId, siteId: notice.siteId, payload: { shipNoticeId: notice.id, number: notice.number, purchaseOrderId: notice.purchaseOrderId, partyId: notice.partyId, status: 'SENT', what: 'PACKING_LIST', expectedDate: dayOf(notice.expectedDate) } })
    return { recordId: current.id }
  },
} satisfies ImportAdapter)

import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { isAreaUom, withOtherUnit, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { AREA_TOLERANCE_PERCENT } from '@nexus/factory-domain/inventory/hides/measure'
import { maySeeSettings, toleranceSettingIn, type ToleranceSetting, type ToleranceSettingSource } from './tolerance'
import type { GradeFacts, RuleFacts } from '@nexus/factory-domain/inventory/hides/usable'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { mayAt, officeContextOf } from '../ledger/access'
import { fixed, locatedBy, type Located } from '../stock/read-kit'

/**
 * What the hides module's reads and commands share (B-W2b-94): the tenant's grades and an article's rules as factory-domain
 * inventory/hides takes them, one hide as the office may see it, its stock from the ledger. Every read runs on the caller's
 * client (row-level security). `gradeIdsByCode` is the receipt's and the opening stock's: a hide received with a grade
 * text that is an active grade's code names that grade as its record too (W1's text-only route moved to the record).
 */

export const GRADE_SELECT = { id: true, code: true, labelIt: true, labelEn: true, usableShare: true, sortOrder: true, active: true } as const satisfies Prisma.LeatherGradeSelect
type GradeRow = Prisma.LeatherGradeGetPayload<{ select: typeof GRADE_SELECT }>

export const gradeFactsOf = (row: GradeRow): GradeFacts => ({ id: row.id, code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, usableShare: row.usableShare.toFixed(2), sortOrder: row.sortOrder, active: row.active })
export const gradeRefOf = (grade: GradeFacts) => ({ id: grade.id, code: grade.code, labelIt: grade.labelIt, labelEn: grade.labelEn, active: grade.active })

/** Every grade of the tenant (retired ones too: a hide keeps the grade it has). */
export async function gradesOf(db: Pick<CommandTx, 'leatherGrade'>): Promise<GradeFacts[]> {
  return (await db.leatherGrade.findMany({ select: GRADE_SELECT })).map(gradeFactsOf)
}

export const RULE_SELECT = { id: true, itemId: true, gradeId: true, usableShare: true, panels: true, active: true, version: true, updatedAt: true } as const satisfies Prisma.ItemGradeRuleSelect
export type RuleRow = Prisma.ItemGradeRuleGetPayload<{ select: typeof RULE_SELECT }>
export const ruleFactsOf = (row: RuleRow): RuleFacts => ({ id: row.id, gradeId: row.gradeId, usableShare: row.usableShare.toFixed(2), panels: row.panels, active: row.active })

/** The rules of these articles (retired ones too), per article. */
export async function rulesOf(db: Pick<CommandTx, 'itemGradeRule'>, itemIds: readonly string[]): Promise<Map<string, RuleRow[]>> {
  const result = new Map<string, RuleRow[]>()
  if (itemIds.length === 0) return result
  for (const row of await db.itemGradeRule.findMany({ where: { itemId: { in: [...new Set(itemIds)] } }, select: RULE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) {
    result.set(row.itemId, [...(result.get(row.itemId) ?? []), row])
  }
  return result
}

/**
 * The active grades by code, for a route that receives a hide's grade as text (the office receipt, the floor's receiving,
 * the tannery's hide list, the opening stock): a text that is exactly an active grade's code names it as the record too.
 */
export async function gradeIdsByCode(db: Pick<CommandTx, 'leatherGrade'>): Promise<ReadonlyMap<string, string>> {
  return new Map((await db.leatherGrade.findMany({ where: { active: true }, select: { id: true, code: true } })).map((row) => [row.code, row.id]))
}

export const HIDE_SELECT = {
  id: true,
  code: true,
  supplierCode: true,
  siteId: true,
  lotId: true,
  itemId: true,
  area: true,
  areaUom: true,
  baseArea: true,
  grade: true,
  shade: true,
  gradeId: true,
  shadeGroupId: true,
  thicknessMm: true,
  defects: true,
  state: true,
  version: true,
  lot: {
    select: {
      id: true,
      code: true,
      companyId: true,
      itemColourId: true,
      dyeBatch: true,
      item: { select: { id: true, code: true, name: true, baseUom: true } },
      itemColour: { select: { id: true, code: true, name: true } },
    },
  },
} as const satisfies Prisma.HideSelect
export type HideData = Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>

const scopeOf = (hide: HideData) => ({ companyId: hide.lot.companyId, siteId: hide.siteId })

/** An area unit of a row the database holds to M2, DM2 or FT2 (leather counts in an area). */
export const areaUom = (uom: string): AreaUom => (isAreaUom(uom) ? uom : 'M2')

/**
 * One hide the office caller may see (inventory.stock.view at its lot's company and site), else not found; with
 * `permission`, it must also hold that one there (else forbidden).
 */
export async function hideFor(caller: CommandCaller, hideId: string, permission?: Permission): Promise<{ hide: HideData; context: OfficeContext }> {
  const context = officeContextOf(caller)
  const hide = isUuid(hideId) ? await caller.withClient((client) => client.hide.findUnique({ where: { id: hideId }, select: HIDE_SELECT })) : null
  if (!hide || !mayAt(context, INVENTORY_STOCK_VIEW, scopeOf(hide))) throw new NotFoundError('Hide not found.')
  if (permission && !mayAt(context, permission, scopeOf(hide))) throw new ForbiddenError(`This needs ${permission} at the hide's site.`)
  return { hide, context }
}

export const mayAtHide = (context: OfficeContext, permission: Permission, hide: HideData): boolean => mayAt(context, permission, scopeOf(hide))

/** What the site's ledger holds of the hide now (base unit) and where. */
export async function stockOfHide(db: Pick<CommandTx, 'stockMove'>, hideId: string): Promise<Located> {
  return (await locatedBy(db, 'hideId', { hideId })).get(hideId) ?? { onHand: ZERO, at: new Map() }
}

/** The head every hide read starts with. */
export function hideHeadOf(hide: HideData, onHand: Decimal) {
  return {
    id: hide.id,
    code: hide.code,
    state: hide.state,
    version: hide.version,
    siteId: hide.siteId,
    companyId: hide.lot.companyId,
    item: hide.lot.item,
    colour: hide.lot.itemColour,
    lot: { id: hide.lot.id, code: hide.lot.code, dyeBatch: hide.lot.dyeBatch },
    area: withOtherUnit(hide.area.toString(), areaUom(hide.areaUom)),
    baseArea: fixed(new Dec(hide.baseArea.toString())),
    onHand: fixed(onHand),
  }
}

/** How many cut log entries name the hide (a reversal counts too: it was cut). */
export async function cutEntriesOf(db: Pick<CommandTx, 'cutLog'>, hideId: string): Promise<number> {
  return db.cutLog.count({ where: { hideId } })
}

export interface Tolerance {
  /** Percent either way, two decimals. */
  readonly percent: string
  /** ORDER_LINE: the area tolerance of the purchase order line the lot was received on; DEFAULT: no line says one (the setting). */
  readonly from: 'ORDER_LINE' | 'DEFAULT'
  /** B-W2b-219: for DEFAULT, the setting it came from: the company's, every company's, or none (2 %). */
  readonly setting?: ToleranceSettingSource | undefined
}

/**
 * The tolerance a lot's area is checked with: its purchase order line's (PurchaseOrderLine.areaTolerancePct, "how far the
 * delivered area may differ", agreed with the tannery), else the company's leather area tolerance (B-W2b-219:
 * PurchasingSettings, the company's row, else every company's, else 2 %: ./tolerance.ts). `setting`: the setting already
 * read for the lot's company (a floor request reads it through the tenant's system scope: leatherToleranceFor); without it
 * the setting is read here when the session may (the office's), else the 2 % default answers (a floor transaction never
 * reads PurchasingSettings).
 */
export async function toleranceOfLot(db: Pick<CommandTx, 'lot' | 'purchasingSettings' | '$queryRaw'>, lotId: string, setting?: ToleranceSetting): Promise<Tolerance> {
  const lot = await db.lot.findUnique({ where: { id: lotId }, select: { tenantId: true, companyId: true, receiptLine: { select: { purchaseOrderLine: { select: { areaTolerancePct: true } } } } } })
  const pct = lot?.receiptLine?.purchaseOrderLine?.areaTolerancePct
  if (pct !== null && pct !== undefined) return { percent: new Dec(pct.toString()).toFixed(2), from: 'ORDER_LINE' }
  const found = setting ?? (lot && (await maySeeSettings(db)) ? await toleranceSettingIn(db, lot.tenantId, lot.companyId) : { percent: AREA_TOLERANCE_PERCENT, from: 'DEFAULT' as const })
  return { percent: found.percent, from: 'DEFAULT', setting: found.from }
}

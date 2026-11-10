import type { FactoryClient, Prisma, StyleRevisionStatus, WorkOrderStatus } from '@nexus/factory-db'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import type { MaterialWhereUsedView, WhereUsedQuery, WhereUsedRow } from '@nexus/factory-domain/product/materials-depth/contracts'
import { CURRENT_REVISION_STATES, WHERE_USED_LIMIT, whereUsedOrder, type ApprovalReach } from '@nexus/factory-domain/product/materials-depth/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { OPEN_STATES, WHERE_USED_PERMISSION } from '@nexus/factory-domain/product/where-used/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, readMaterial } from '../materials/store'
import { STYLE_SCOPE } from '../styles/store'

/**
 * Where a material is used (B-W2b-238; PRD-036; design products.materials "Where used", the list's Used in column and its
 * "Not used in any BOM" tile). Every BOM line that names the material, and every alternate on a line that names it, of every
 * revision (draft, released, obsolete), with the colour each takes and the revision's open work orders.
 *
 *   styles        only those the person reads (product.styles.view over the style's company): another company's style is
 *                 neither listed nor counted; without the permission at all: no row (`stylesAllowed: false`)
 *   work orders   the revision's open ones (draft, released, in progress, on hold) the person reads (workorders.view over
 *                 their company and site); without the permission: null
 *   "used"        named by a DRAFT or RELEASED revision (the list's column, its filter and the approval's reach); an OBSOLETE
 *                 revision is history, shown in the tab with its state
 *
 * Read with the request's client (or a command's transaction), one query after another; nothing written. No money.
 */

type Reader = FactoryClient | CommandTx

const OPEN_WORK_ORDERS = OPEN_STATES.WORK_ORDERS as WorkOrderStatus[]
const CURRENT = [...CURRENT_REVISION_STATES] as StyleRevisionStatus[]
const WORK_ORDERS = WHERE_USED_PERMISSION.WORK_ORDERS

interface LineUse {
  readonly lineId: string
  readonly role: 'LINE' | 'ALTERNATE'
  readonly priority: number | null
  readonly styleId: string
  readonly revisionId: string
  readonly seq: number
  readonly placement: string | null
  readonly section: string | null
  /** The fixed colour (a line's itemColourId, an alternate's). */
  readonly itemColourId: string | null
  /** Per colourway (a line's BomLineColour rows). */
  readonly colourways: readonly { readonly colourwayId: string; readonly itemColourId: string }[]
}

/** Every line and alternate naming the material (any revision). */
async function usesOf(db: Reader, itemId: string): Promise<LineUse[]> {
  const lines = await db.bomLine.findMany({
    where: { itemId },
    select: { id: true, styleId: true, revisionId: true, seq: true, placement: true, section: true, itemColourId: true, colours: { select: { colourwayId: true, itemColourId: true } } },
  })
  const alternates = await db.bomLineAlternate.findMany({
    where: { itemId },
    select: { priority: true, itemColourId: true, revisionId: true, bomLine: { select: { id: true, styleId: true, seq: true, placement: true, section: true } } },
  })
  return [
    ...lines.map((line) => ({ lineId: line.id, role: 'LINE' as const, priority: null, styleId: line.styleId, revisionId: line.revisionId, seq: line.seq, placement: line.placement, section: line.section, itemColourId: line.itemColourId, colourways: line.colours })),
    ...alternates.map((alternate) => ({
      lineId: alternate.bomLine.id,
      role: 'ALTERNATE' as const,
      priority: alternate.priority,
      styleId: alternate.bomLine.styleId,
      revisionId: alternate.revisionId,
      seq: alternate.bomLine.seq,
      placement: alternate.bomLine.placement,
      section: alternate.bomLine.section,
      itemColourId: alternate.itemColourId,
      colourways: [],
    })),
  ]
}

/** The styles among `ids` the actor reads (none without product.styles.view). */
async function visibleStyles(db: Reader, actor: Actor, ids: readonly string[]) {
  if (ids.length === 0 || !holds(actor, PRODUCT_STYLES_VIEW)) return []
  return db.style.findMany({
    where: { AND: [{ id: { in: [...new Set(ids)] } }, scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput] },
    select: { id: true, code: true, name: true, companyId: true, status: true },
  })
}

/** The open work orders of these revisions the actor reads (null without workorders.view). */
async function openWorkOrdersOf(db: Reader, actor: Actor, revisionIds: readonly string[]) {
  if (!holds(actor, WORK_ORDERS)) return null
  if (revisionIds.length === 0) return []
  return db.workOrder.findMany({
    where: { AND: [{ styleRevisionId: { in: [...new Set(revisionIds)] } }, { status: { in: OPEN_WORK_ORDERS } }, scopeWhere(actor, WORK_ORDERS, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput] },
    select: { id: true, number: true, status: true, siteId: true, styleRevisionId: true },
    orderBy: [{ number: 'asc' }],
  })
}

/** What a decision on the material reaches now (the approval card and its confirmation). */
export async function reachOf(db: Reader, actor: Actor, itemId: string): Promise<Omit<ApprovalReach, 'openWorkOrders'> & { readonly styles: number; readonly openWorkOrders: number | null }> {
  const uses = await usesOf(db, itemId)
  const styles = new Set((await visibleStyles(db, actor, uses.map((use) => use.styleId))).map((style) => style.id))
  const seen = uses.filter((use) => styles.has(use.styleId))
  const revisions = seen.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: [...new Set(seen.map((use) => use.revisionId))] } }, select: { id: true, status: true, styleId: true } })
  const current = revisions.filter((revision) => CURRENT.includes(revision.status))
  const released = revisions.filter((revision) => revision.status === 'RELEASED').map((revision) => revision.id)
  const orders = await openWorkOrdersOf(db, actor, released)
  return {
    styles: new Set(current.map((revision) => revision.styleId)).size,
    draftRevisions: revisions.filter((revision) => revision.status === 'DRAFT').length,
    releasedRevisions: released.length,
    openWorkOrders: orders === null ? null : orders.length,
  }
}

/** GET /product/materials/:materialId/where-used */
export async function materialWhereUsed(caller: CommandCaller, materialId: string, query: WhereUsedQuery): Promise<MaterialWhereUsedView> {
  const material = await readMaterial(caller, materialId)
  const actor = actorOf(contextOf(caller))
  return caller.withClient(async (db) => {
    const colours = await db.itemColour.findMany({ where: { itemId: materialId }, select: { id: true, code: true, name: true, status: true }, orderBy: [{ code: 'asc' }] })
    const itemColourId = query.itemColourId ?? null
    if (itemColourId !== null && !colours.some((colour) => colour.id === itemColourId)) {
      throw new ValidationError('Not a colour of this material.', [{ path: 'querystring/itemColourId', message: `Pick one of ${material.code}'s colours.` }])
    }
    const stylesAllowed = holds(actor, PRODUCT_STYLES_VIEW)
    const uses = await usesOf(db, materialId)
    const styles = new Map((await visibleStyles(db, actor, uses.map((use) => use.styleId))).map((style) => [style.id, style]))
    const seen = uses.filter((use) => styles.has(use.styleId))
    const takes = (use: LineUse, colourId: string) => use.itemColourId === colourId || use.colourways.some((entry) => entry.itemColourId === colourId)
    const shown = itemColourId === null ? seen : seen.filter((use) => takes(use, itemColourId))

    const revisions = new Map(
      (seen.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: [...new Set(seen.map((use) => use.revisionId))] } }, select: { id: true, revision: true, status: true, styleId: true } })).map((revision) => [revision.id, revision]),
    )
    const colourwayIds = [...new Set(shown.flatMap((use) => use.colourways.map((entry) => entry.colourwayId)))]
    const colourways = new Map((colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const colourRef = new Map(colours.map((colour) => [colour.id, { id: colour.id, code: colour.code, name: colour.name }]))
    const orders = await openWorkOrdersOf(db, actor, [...revisions.keys()])

    const rows: WhereUsedRow[] = shown.flatMap((use) => {
      const style = styles.get(use.styleId)
      const revision = revisions.get(use.revisionId)
      if (!style || !revision) return []
      return [
        {
          lineId: use.lineId,
          role: use.role,
          priority: use.priority,
          style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
          revision: { id: revision.id, revision: revision.revision, status: revision.status },
          seq: use.seq,
          placement: use.placement,
          section: use.section,
          colour: use.itemColourId ? (colourRef.get(use.itemColourId) ?? null) : null,
          colourways: use.colourways.flatMap((entry) => {
            const colour = colourRef.get(entry.itemColourId)
            return colour ? [{ colourwayId: entry.colourwayId, colourwayCode: colourways.get(entry.colourwayId) ?? '—', colour }] : []
          }),
          openWorkOrders: orders === null ? null : orders.filter((order) => order.styleRevisionId === use.revisionId).map((order) => ({ id: order.id, number: order.number, status: order.status, siteId: order.siteId })),
        },
      ]
    })
    const ordered = whereUsedOrder(rows)
    const counted = [...revisions.values()]
    const current = counted.filter((revision) => CURRENT.includes(revision.status))
    const released = new Set(counted.filter((revision) => revision.status === 'RELEASED').map((revision) => revision.id))
    return {
      material: { id: material.id, code: material.code, name: material.name, kind: material.kind as MaterialWhereUsedView['material']['kind'], companyId: material.companyId, status: material.status, version: material.version },
      stylesAllowed,
      workOrdersAllowed: orders !== null,
      summary: {
        styles: new Set(current.map((revision) => revision.styleId)).size,
        draftRevisions: counted.filter((revision) => revision.status === 'DRAFT').length,
        releasedRevisions: released.size,
        obsoleteRevisions: counted.filter((revision) => revision.status === 'OBSOLETE').length,
        lines: seen.filter((use) => use.role === 'LINE').length,
        alternates: seen.filter((use) => use.role === 'ALTERNATE').length,
        openWorkOrders: orders === null ? null : orders.filter((order) => order.styleRevisionId !== null && released.has(order.styleRevisionId)).length,
      },
      colours: colours.map((colour) => ({ colour: { id: colour.id, code: colour.code, name: colour.name }, status: colour.status, lines: seen.filter((use) => takes(use, colour.id)).length })),
      itemColourId,
      rows: ordered.slice(0, WHERE_USED_LIMIT),
      more: ordered.length > WHERE_USED_LIMIT,
    }
  })
}

// ---- the material list (W1's GET /product/materials reads these) --------------------------------------------------------

/** The current BOM uses the actor reads: a line or an alternate of a DRAFT or RELEASED revision of a style it reads. */
function currentUse(actor: Actor): Prisma.BomLineWhereInput {
  return { revision: { status: { in: CURRENT }, style: scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput } }
}

/** The list's `used` filter: named by a current BOM (true) or by none (false, the "Not used in any BOM" tile). */
export function usedFilter(actor: Actor, used: boolean): Prisma.ItemWhereInput {
  const use = currentUse(actor)
  return used ? { OR: [{ bomLines: { some: use } }, { bomLineAlternates: { some: { bomLine: use } } }] } : { AND: [{ bomLines: { none: use } }, { bomLineAlternates: { none: { bomLine: use } } }] }
}

/** The list's Used in column: per material, the styles whose current BOM names it (null: the actor reads no styles). */
export async function usageCounts(db: Reader, actor: Actor, itemIds: readonly string[]): Promise<Map<string, number> | null> {
  if (!holds(actor, PRODUCT_STYLES_VIEW)) return null
  const counts = new Map<string, Set<string>>(itemIds.map((id) => [id, new Set<string>()]))
  if (itemIds.length === 0) return new Map()
  const use = currentUse(actor)
  const lines = await db.bomLine.findMany({ where: { AND: [{ itemId: { in: [...itemIds] } }, use] }, select: { itemId: true, styleId: true }, distinct: ['itemId', 'styleId'] })
  const alternates = await db.bomLineAlternate.findMany({ where: { AND: [{ itemId: { in: [...itemIds] } }, { bomLine: use }] }, select: { itemId: true, bomLine: { select: { styleId: true } } } })
  for (const line of lines) counts.get(line.itemId)?.add(line.styleId)
  for (const alternate of alternates) counts.get(alternate.itemId)?.add(alternate.bomLine.styleId)
  return new Map([...counts.entries()].map(([id, styles]) => [id, styles.size]))
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BomLineData } from '@nexus/factory-domain/product/bom/rules'
import type { StructureAlternate, StructureLine, StructureMaterial } from '@nexus/factory-domain/product/bom-structure/check'
import { subAssemblyCircle, type BomSection, type CircleVerdict, type MaterialApproval, type SubAssemblyEdge, type SubAssemblyTarget } from '@nexus/factory-domain/product/bom-structure/rules'
import type { ItemSourcing } from '@nexus/factory-domain/product/materials/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import type { MaterialFacts } from '../bom/store'

/**
 * The BOM structure's rows (B-W2b-223): B-W2b-211's columns of W1's BomLine (section, group row, sub-assembly, and the
 * columns other steps write: customer-supplied, the workshop's kit, the rule that made it, the option, the made-to-measure
 * point), the alternates, the revisions lines take as sub-assemblies (with their style's range, colourways and output) and
 * the tenant's sub-assembly links the circle rule walks. Every read names its columns; queries run one after another (a
 * transaction client runs one at a time).
 *
 * Locks (after W1's: the style row FOR UPDATE, the revision by compare-and-set, the materials FOR SHARE): the revisions a
 * line takes as sub-assemblies FOR SHARE (by id: not released, made obsolete or changed under the write or the release),
 * then the tenant's sub-assembly links in turns (`lockSubAssemblyLinks`: the advisory lock the database's own rule takes,
 * so the circle read here is the one the database checks).
 */

export type Reader = FactoryClient | CommandTx

const text = (value: { toString(): string }): string => decimalText(value.toString())

export const STRUCTURE_COLUMNS = {
  id: true,
  styleId: true,
  revisionId: true,
  seq: true,
  itemId: true,
  placement: true,
  qty: true,
  uom: true,
  section: true,
  parentLineId: true,
  subAssemblyStyleId: true,
  subAssemblyRevisionId: true,
  customerSuppliedByPartyId: true,
  issueToSubcontract: true,
  sourceKey: true,
  optionValueId: true,
  mtmScalePointId: true,
  mtmScaleFactor: true,
  supplierId: true,
  version: true,
} as const satisfies Prisma.BomLineSelect
type StructureRow = Prisma.BomLineGetPayload<{ select: typeof STRUCTURE_COLUMNS }>

/** A line's structure as stored (decimals as plain decimal text). */
export interface StructureRecord {
  readonly id: string
  readonly styleId: string
  readonly revisionId: string
  readonly seq: number
  readonly itemId: string
  readonly placement: string | null
  readonly qty: string
  readonly uom: StructureRow['uom']
  readonly section: BomSection | null
  readonly parentLineId: string | null
  readonly subAssemblyStyleId: string | null
  readonly subAssemblyRevisionId: string | null
  readonly customerSuppliedByPartyId: string | null
  readonly issueToSubcontract: boolean
  readonly sourceKey: string | null
  readonly optionValueId: string | null
  readonly mtmScalePointId: string | null
  readonly mtmScaleFactor: string | null
  readonly supplierId: string | null
  readonly version: number
}

const recordOf = (row: StructureRow): StructureRecord => ({ ...row, qty: text(row.qty), mtmScaleFactor: row.mtmScaleFactor === null ? null : text(row.mtmScaleFactor) })

/** The structure of a revision's lines, in BOM order. */
export async function readStructure(db: Reader, revisionId: string): Promise<StructureRecord[]> {
  const rows = await db.bomLine.findMany({ where: { revisionId }, select: STRUCTURE_COLUMNS, orderBy: { seq: 'asc' } })
  return rows.map(recordOf)
}

/** The structure of some lines (by id). */
export async function readStructureOf(db: Reader, lineIds: readonly string[]): Promise<StructureRecord[]> {
  if (lineIds.length === 0) return []
  return (await db.bomLine.findMany({ where: { id: { in: [...lineIds] } }, select: STRUCTURE_COLUMNS, orderBy: { seq: 'asc' } })).map(recordOf)
}

/** What the structure rules read of a material beyond W1's facts: how it is sourced, its approval, whether it is a PPE component. */
export interface MaterialExtras {
  readonly sourcing: ItemSourcing
  readonly approval: MaterialApproval
  readonly isPpeComponent: boolean
  readonly approvalNote: string | null
}

export async function readMaterialExtras(db: Reader, itemIds: readonly string[]): Promise<Map<string, MaterialExtras>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, sourcing: true, approval: true, isPpeComponent: true, approvalNote: true } })
  return new Map(rows.map((row) => [row.id, { sourcing: row.sourcing, approval: row.approval, isPpeComponent: row.isPpeComponent, approvalNote: row.approvalNote }]))
}

/** W1's material facts with the extras: what the BOM check reads. */
export function structureMaterialOf(material: MaterialFacts, extras: MaterialExtras | undefined): StructureMaterial {
  return {
    id: material.id,
    code: material.code,
    kind: material.kind,
    sourcing: extras?.sourcing ?? 'BUY',
    status: material.status,
    approval: extras?.approval ?? 'PENDING',
    isPpeComponent: extras?.isPpeComponent ?? false,
    units: material.units,
  }
}

/** The alternates of a revision's lines, with their material's code, status and approval. */
export async function readAlternates(db: Reader, revisionId: string): Promise<(StructureAlternate & { readonly itemId: string })[]> {
  const rows = await db.bomLineAlternate.findMany({ where: { revisionId }, select: { id: true, bomLineId: true, priority: true, itemId: true }, orderBy: [{ bomLineId: 'asc' }, { priority: 'asc' }] })
  if (rows.length === 0) return []
  const items = await db.item.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.itemId))] } }, select: { id: true, code: true, status: true, approval: true } })
  const itemOf = new Map(items.map((item) => [item.id, item]))
  return rows.map((row) => {
    const item = itemOf.get(row.itemId)
    return { id: row.id, lineId: row.bomLineId, priority: row.priority, itemId: row.itemId, code: item?.code ?? '', status: item?.status ?? 'ARCHIVED', approval: item?.approval ?? 'PENDING' }
  })
}

/** A sub-assembly revision as the rules read it, with the style's name and company (who may name it). */
export interface TargetRecord extends SubAssemblyTarget {
  readonly name: string
  readonly companyId: string | null
}

/** The revisions named (by id; one not found is left out), each with its style's range and colourways; FOR SHARE when `lock`. */
export async function readTargets(db: Reader, revisionIds: readonly string[], lock = false): Promise<Map<string, TargetRecord>> {
  const ids = [...new Set(revisionIds)].sort()
  if (ids.length === 0) return new Map()
  if (lock) await (db as CommandTx).$queryRaw`SELECT "id" FROM "StyleRevision" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`
  const revisions = await db.styleRevision.findMany({ where: { id: { in: ids } }, select: { id: true, styleId: true, revision: true, status: true, outputQuantity: true, outputUom: true } })
  const styleIds = [...new Set(revisions.map((row) => row.styleId))]
  const styles = styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, status: true, companyId: true, sizes: true } })
  const colourways = styleIds.length === 0 ? [] : await db.colourway.findMany({ where: { styleId: { in: styleIds } }, select: { id: true, styleId: true, code: true, status: true }, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const out = new Map<string, TargetRecord>()
  for (const row of revisions) {
    const style = styleOf.get(row.styleId)
    if (!style) continue
    out.set(row.id, {
      styleId: style.id,
      code: style.code,
      name: style.name,
      companyId: style.companyId,
      styleStatus: style.status,
      revisionId: row.id,
      revision: row.revision,
      status: row.status,
      sizes: [...style.sizes],
      colourways: colourways.filter((colourway) => colourway.styleId === style.id).map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })),
      outputQuantity: row.outputQuantity,
      outputUom: row.outputUom,
    })
  }
  return out
}

/** The tenant's sub-assembly links as the circle rule reads them, with the line that makes each. */
export async function readEdges(db: Reader): Promise<(SubAssemblyEdge & { readonly lineId: string })[]> {
  const rows = await db.bomLine.findMany({
    where: { subAssemblyRevisionId: { not: null } },
    select: { id: true, styleId: true, revisionId: true, subAssemblyStyleId: true, subAssemblyRevisionId: true },
  })
  return rows.map((row) => ({ lineId: row.id, fromRevisionId: row.revisionId, fromStyleId: row.styleId, toRevisionId: row.subAssemblyRevisionId!, toStyleId: row.subAssemblyStyleId! }))
}

/** The session tenant's sub-assembly links in turns: the database's own rule takes this advisory lock for the same walk. */
export async function lockSubAssemblyLinks(tx: CommandTx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bom-sub-assembly', current_setting('factory.tenant_id', true)::uuid), 0))`
}

/** The circle and depth verdict of every sub-assembly line of `lines` (each line's own link left out of the walk). */
export function circlesOf(lines: readonly StructureRecord[], edges: readonly (SubAssemblyEdge & { readonly lineId: string })[]): Map<string, CircleVerdict> {
  const out = new Map<string, CircleVerdict>()
  for (const line of lines) {
    if (line.subAssemblyRevisionId === null || line.subAssemblyStyleId === null) continue
    const others = edges.filter((edge) => edge.lineId !== line.id)
    out.set(line.id, subAssemblyCircle({ revisionId: line.revisionId, styleId: line.styleId }, { revisionId: line.subAssemblyRevisionId, styleId: line.subAssemblyStyleId }, others))
  }
  return out
}

/** Style codes by id (for the circle's words). */
export async function readStyleCodes(db: Reader, styleIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(styleIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
}

/** A W1 line and its structure, as the BOM check reads it. */
export function structureLineOf(line: Pick<BomLineData, 'id' | 'seq' | 'itemId' | 'uom' | 'sizeDependent' | 'sizes' | 'colourwayId'>, record: StructureRecord | undefined): StructureLine {
  return {
    id: line.id,
    seq: line.seq,
    itemId: line.itemId,
    uom: line.uom,
    sizeDependent: line.sizeDependent,
    sizes: line.sizes,
    colourwayId: line.colourwayId,
    section: record?.section ?? null,
    parentLineId: record?.parentLineId ?? null,
    subAssemblyRevisionId: record?.subAssemblyRevisionId ?? null,
    customerSupplied: (record?.customerSuppliedByPartyId ?? null) !== null,
  }
}

import { DomainError } from '@nexus/factory-domain/core/errors'
import { bomCheck, structureIssues, structureRefusalIssues, type BomCheck, type BomCheckItem } from '@nexus/factory-domain/product/bom-structure/check'
import type { BomCheckView } from '@nexus/factory-domain/product/bom-structure/contracts'
import { decimalText, type Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTools, CommandTx } from '../../../core/command'
import {
  bomStyleOf,
  findRevision,
  loadBom,
  lockMaterials,
  readColourways,
  readLines,
  readMaterials,
  releaseBlocked,
  releaseCheck,
  type BomStyleRow,
  type LoadedBom,
  type ReleaseIssue,
  type RevisionRow,
} from '../bom/store'
import {
  circlesOf,
  readAlternates,
  readEdges,
  readMaterialExtras,
  readStructure,
  readStyleCodes,
  readTargets,
  structureLineOf,
  structureMaterialOf,
  type MaterialExtras,
  type Reader,
  type StructureRecord,
  type TargetRecord,
} from './store'

/**
 * THE BOM check of a revision (B-W2b-223; PRD-087, PRD-106): W1's release check (product/bom store `releaseCheck`: the BOM
 * and the routing) and the structure's (factory-domain product/bom-structure/check), every problem in words with its cell.
 * One read for the BOM structure view, the check route and the release (./structureBlockersInCommand, called by W1's
 * product/bom revisions.ts releaseRevision before the database's own refusal), so the check never says a release would
 * pass that is refused.
 */

/** Everything the structure view and the check read, with one client. */
export interface LoadedStructure {
  readonly bom: LoadedBom
  readonly records: readonly StructureRecord[]
  readonly extras: ReadonlyMap<string, MaterialExtras>
  readonly alternates: Awaited<ReturnType<typeof readAlternates>>
  readonly targets: ReadonlyMap<string, TargetRecord>
  readonly circles: ReturnType<typeof circlesOf>
  readonly styleCodes: ReadonlyMap<string, string>
  readonly ppe: boolean
  /** What the revision's BOM makes (B-W2b-211's columns; W1's revision read does not name them). */
  readonly output: { readonly outputQuantity: number; readonly outputUom: Uom }
}

export async function loadStructure(db: Reader, style: BomStyleRow, revision: RevisionRow): Promise<LoadedStructure> {
  const bom = await loadBom(db, style, revision)
  const records = await readStructure(db, revision.id)
  const extras = await readMaterialExtras(db, records.map((line) => line.itemId))
  const alternates = await readAlternates(db, revision.id)
  const targets = await readTargets(db, records.flatMap((line) => (line.subAssemblyRevisionId ? [line.subAssemblyRevisionId] : [])))
  const named = records.some((line) => line.subAssemblyRevisionId !== null)
  const edges = named ? await readEdges(db) : []
  const circles = circlesOf(records, edges)
  const styleCodes = await readStyleCodes(db, edges.flatMap((edge) => [edge.fromStyleId, edge.toStyleId]))
  const ppe = (await db.style.findUniqueOrThrow({ where: { id: style.id }, select: { ppeCategory: true } })).ppeCategory !== 'NOT_PPE'
  const output = await db.styleRevision.findUniqueOrThrow({ where: { id: revision.id }, select: { outputQuantity: true, outputUom: true } })
  return { bom, records, extras, alternates, targets, circles, styleCodes, ppe, output }
}

/** The structure's findings of a loaded revision. */
export function structureCheckOf(loaded: LoadedStructure): BomCheck {
  const { bom } = loaded
  const recordOf = new Map(loaded.records.map((record) => [record.id, record]))
  const materials = new Map([...bom.materials].map(([id, material]) => [id, structureMaterialOf(material, loaded.extras.get(id))]))
  return structureIssues({
    lines: bom.lines.map((line) => structureLineOf(line, recordOf.get(line.id))),
    materials,
    alternates: loaded.alternates,
    style: { id: bom.style.id, ...bomStyleOf(bom.style, bom.colourways), ppe: loaded.ppe },
    subAssemblies: loaded.targets,
    circles: loaded.circles,
    codeOf: (styleId) => loaded.styleCodes.get(styleId) ?? '?',
  })
}

const revisionRefOf = (revision: RevisionRow) => ({ id: revision.id, styleId: revision.styleId, revision: revision.revision, status: revision.status, version: revision.version })

/** The BOM check view: a draft is checked (W1's findings and the structure's); a frozen revision is not. */
export function checkViewOf(loaded: LoadedStructure): BomCheckView {
  const { bom } = loaded
  const draft = bom.revision.status === 'DRAFT'
  if (!draft) return { revision: revisionRefOf(bom.revision), checked: false, blockers: [], warnings: [], count: 0, releasable: false }
  const release = releaseCheck({
    lines: bom.lines,
    style: bomStyleOf(bom.style, bom.colourways),
    materials: bom.materials,
    plannedHideYieldPct: bom.revision.plannedHideYieldPct === null ? null : decimalText(bom.revision.plannedHideYieldPct.toString()),
    steps: bom.steps,
    operations: bom.routingOperations,
  })
  const seqOf = new Map(bom.lines.map((line) => [line.id, line.seq]))
  const check = bomCheck(release, structureCheckOf(loaded), (lineId) => seqOf.get(lineId))
  return {
    revision: revisionRefOf(bom.revision),
    checked: true,
    blockers: [...check.blockers],
    warnings: [...check.warnings],
    count: check.blockers.length + check.warnings.length,
    releasable: bom.style.status !== 'ARCHIVED' && check.blockers.length === 0,
  }
}

/**
 * Inside the release command (W1's product/bom revisions.ts releaseRevision), after its locks and its own check: the
 * structure's blockers, read as they are now. The revisions the lines take as sub-assemblies are held FOR SHARE and the
 * alternates' materials FOR SHARE (in id order), so none is released, made obsolete or blocked between this check and the
 * commit (the database's rules read the same rows at the status change).
 */
export async function structureBlockersInCommand(tools: Pick<CommandTools, 'tx'>, target: { readonly styleId: string; readonly revisionId: string }): Promise<BomCheckItem[]> {
  const { tx } = tools
  const records = await readStructure(tx, target.revisionId)
  const alternates = await readAlternates(tx, target.revisionId)
  const named = records.some((line) => line.subAssemblyRevisionId !== null)
  if (!named && alternates.length === 0 && !(await anyBlocked(tx, records))) return []
  await lockMaterials(tx, alternates.map((alternate) => alternate.itemId))
  const lines = await readLines(tx, target.revisionId)
  const { materials } = await readMaterials(tx, lines.map((line) => line.itemId))
  const extras = await readMaterialExtras(tx, lines.map((line) => line.itemId))
  const targets = await readTargets(tx, records.flatMap((line) => (line.subAssemblyRevisionId ? [line.subAssemblyRevisionId] : [])), true)
  const edges = named ? await readEdges(tx) : []
  const styleCodes = await readStyleCodes(tx, edges.flatMap((edge) => [edge.fromStyleId, edge.toStyleId]))
  const style = await tx.style.findUniqueOrThrow({ where: { id: target.styleId }, select: { id: true, sizes: true, baseSize: true, ppeCategory: true } })
  const recordOf = new Map(records.map((record) => [record.id, record]))
  const { blockers } = structureIssues({
    lines: lines.map((line) => structureLineOf(line, recordOf.get(line.id))),
    materials: new Map([...materials].map(([id, material]) => [id, structureMaterialOf(material, extras.get(id))])),
    alternates,
    style: { id: style.id, ...bomStyleOf(style, await readColourways(tx, target.styleId)), ppe: style.ppeCategory !== 'NOT_PPE' },
    subAssemblies: targets,
    circles: circlesOf(records, edges),
    codeOf: (styleId) => styleCodes.get(styleId) ?? '?',
  })
  return [...blockers]
}

/** True when a line's material is BLOCKED (the one structure blocker a BOM without sub-assemblies or alternates can have). */
async function anyBlocked(tx: CommandTx, records: readonly StructureRecord[]): Promise<boolean> {
  const ids = [...new Set(records.map((line) => line.itemId))]
  return ids.length > 0 && (await tx.item.count({ where: { id: { in: ids }, approval: 'BLOCKED' } })) > 0
}

/**
 * The release's refusal when the structure has blockers (W1's own blockers, if any, come first with their own paths): one
 * 409 listing every problem, before the database refuses the release in its own words. Nothing when the structure has none:
 * W1's refusal (if any) is then W1's, unchanged.
 */
export function assertStructureReleasable(release: readonly ReleaseIssue[], structure: readonly BomCheckItem[]): void {
  if (structure.length === 0) return
  const issues = [...(release.length > 0 ? (releaseBlocked(release).issues ?? []) : []), ...structureRefusalIssues(structure)]
  throw new DomainError('invalid_state', `The BOM is not ready to release: ${issues.length} problem(s) to fix first.`, issues)
}

/** The revision as the check reads it (a read with the caller's client). */
export async function checkFor(db: Reader, style: BomStyleRow, revisionId: string): Promise<BomCheckView> {
  return checkViewOf(await loadStructure(db, style, await findRevision(db, style.id, revisionId)))
}

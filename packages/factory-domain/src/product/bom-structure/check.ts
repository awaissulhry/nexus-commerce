import { BOM_BLOCKERS, BOM_WARNINGS, type BomColourway, type BomIssueCode, type SizeQuantity } from '../bom/rules'
import type { ItemKind, ItemSourcing, MaterialStatus } from '../materials/rules'
import { ROUTING_BLOCKERS, ROUTING_WARNINGS, type RoutingIssueCode } from '../routing/rules'
import { decimalOf, UNITS, type ItemUnits, type Uom } from '../units/units'
import {
  circleProblem,
  inGroupCircle,
  outputBatches,
  subAssemblyColourway,
  subAssemblyMaterialProblem,
  subAssemblySize,
  SUB_ASSEMBLY_UOMS,
  type BomSection,
  type CircleVerdict,
  type MaterialApproval,
  type SubAssemblyTarget,
} from './rules'

/**
 * THE BOM check (B-W2b-223; PRD-087, PRD-106; design style.bom.check "What stops this BOM from being released, live"),
 * pure: every problem of a draft revision in words, each with the cell to fix (`cell`: the line, its column, the size, the
 * colourway, the alternate or the routing step), blockers (the release refuses them) and warnings (shown only). It is W1's
 * release check (product/bom `bomIssues` and product/routing `routingIssues`, each finding given its cell) plus the
 * structure's:
 *
 *   MATERIAL_BLOCKED           a line's material is BLOCKED (B-W2b-206: refused for use; the database refuses the release)
 *   ALTERNATE_BLOCKED          an alternate is a BLOCKED material (the database refuses the release)
 *   SUB_ASSEMBLY_NOT_RELEASED  a sub-assembly revision is DRAFT or OBSOLETE: no draft part under a released parent (PRD-106)
 *   SUB_ASSEMBLY_NOT_MADE      a sub-assembly line's material is no longer a COMPONENT we make in PCS, PAIR or SET, or is
 *                              sent by the customer (changed after the link was made)
 *   SUB_ASSEMBLY_CIRCLE        a style inside its own sub-assemblies (the database refuses the link; listed all the same)
 *   SUB_ASSEMBLY_TOO_DEEP      more than MAX_BOM_LEVELS levels
 *   SUB_ASSEMBLY_UNIT          the line's unit does not convert to what the sub-assembly's BOM makes
 *   SUB_ASSEMBLY_SIZE_MISSING  a size of the style that uses the line has no size of the sub-assembly ("a size without quantity")
 *   SUB_ASSEMBLY_COLOURWAY_MISSING  an active colourway that uses the line has no colourway of the sub-assembly
 *   GROUP_CIRCLE               a line grouped under a line grouped under it (the database refuses it; listed all the same)
 *
 * and the warnings PPE_MATERIAL_NOT_APPROVED (a PPE line, on a PPE style: a PPE component or a line filed under protection,
 * whose material is not approved yet: it can still be released, as no route approves a material yet), ALTERNATE_ARCHIVED
 * (never taken) and SUB_ASSEMBLY_STYLE_ARCHIVED. W1's MATERIAL_ARCHIVED and SIZE_QUANTITY_MISSING cover an archived material
 * and a size without quantity on the line itself.
 */

export const STRUCTURE_BLOCKERS = [
  'MATERIAL_BLOCKED',
  'ALTERNATE_BLOCKED',
  'SUB_ASSEMBLY_NOT_RELEASED',
  'SUB_ASSEMBLY_NOT_MADE',
  'SUB_ASSEMBLY_CIRCLE',
  'SUB_ASSEMBLY_TOO_DEEP',
  'SUB_ASSEMBLY_UNIT',
  'SUB_ASSEMBLY_SIZE_MISSING',
  'SUB_ASSEMBLY_COLOURWAY_MISSING',
  'GROUP_CIRCLE',
] as const
export const STRUCTURE_WARNINGS = ['PPE_MATERIAL_NOT_APPROVED', 'ALTERNATE_ARCHIVED', 'SUB_ASSEMBLY_STYLE_ARCHIVED'] as const
export type StructureIssueCode = (typeof STRUCTURE_BLOCKERS)[number] | (typeof STRUCTURE_WARNINGS)[number]

/** Every code the BOM check answers with: W1's BOM and routing codes, then the structure's. */
export const BOM_CHECK_CODES = [...BOM_BLOCKERS, ...BOM_WARNINGS, ...ROUTING_BLOCKERS, ...ROUTING_WARNINGS, ...STRUCTURE_BLOCKERS, ...STRUCTURE_WARNINGS] as const
export type BomCheckCode = (typeof BOM_CHECK_CODES)[number]

/** The column of the BOM (or the record) a finding lands on: "Show me" goes there. */
export const BOM_CHECK_COLUMNS = [
  'itemId',
  'uom',
  'qty',
  'wastagePct',
  'sizes',
  'colours',
  'itemColourId',
  'colourwayId',
  'section',
  'parentLineId',
  'subAssembly',
  'alternates',
  'plannedHideYieldPct',
  'style',
  'routing',
] as const
export type BomCheckColumn = (typeof BOM_CHECK_COLUMNS)[number]

export const BOM_CHECK_SEVERITIES = ['BLOCKER', 'WARNING'] as const
export type BomCheckSeverity = (typeof BOM_CHECK_SEVERITIES)[number]

export interface BomCheckCell {
  readonly lineId: string | null
  readonly column: BomCheckColumn | null
  readonly size: string | null
  readonly colourwayId: string | null
  readonly alternateId: string | null
  readonly stepId: string | null
}

export interface BomCheckItem {
  readonly code: BomCheckCode
  readonly severity: BomCheckSeverity
  readonly message: string
  readonly cell: BomCheckCell
}

export interface BomCheck {
  readonly blockers: readonly BomCheckItem[]
  readonly warnings: readonly BomCheckItem[]
}

const cellOf = (at: Partial<BomCheckCell>): BomCheckCell => ({
  lineId: at.lineId ?? null,
  column: at.column ?? null,
  size: at.size ?? null,
  colourwayId: at.colourwayId ?? null,
  alternateId: at.alternateId ?? null,
  stepId: at.stepId ?? null,
})

// ---- W1's findings, each given its cell ---------------------------------------------------------------------------------

const W1_COLUMN: Readonly<Record<BomIssueCode | RoutingIssueCode, BomCheckColumn | null>> = {
  NO_LINES: null,
  NO_SIZE_RANGE: 'style',
  NO_ACTIVE_COLOURWAY: 'style',
  MATERIAL_ARCHIVED: 'itemId',
  UNIT_NOT_CONVERTIBLE: 'uom',
  QUANTITY_NOT_POSITIVE: 'qty',
  WASTAGE_OUT_OF_RANGE: 'wastagePct',
  SIZE_QUANTITY_MISSING: 'sizes',
  SIZE_OUTSIDE_RANGE: 'sizes',
  SIZE_QUANTITIES_ALL_ZERO: 'sizes',
  COLOUR_MISSING: 'colours',
  COLOUR_ARCHIVED: 'colours',
  LEATHER_WITHOUT_WASTAGE: 'wastagePct',
  NO_PLANNED_HIDE_YIELD: 'plannedHideYieldPct',
  LINE_OF_ARCHIVED_COLOURWAY: 'colourwayId',
  NO_STEPS: 'routing',
  MINUTES_NOT_POSITIVE: 'routing',
  NO_SCAN_POINT: 'routing',
  PARALLEL_GROUP_SPLIT: 'routing',
  FINAL_SIDE_BY_SIDE: 'routing',
  OPERATION_ARCHIVED: 'routing',
  LAST_STEP_NOT_SCANNED: 'routing',
  PARALLEL_GROUP_ALONE: 'routing',
}

/** A finding of W1's release check (the API's ReleaseIssue). */
export interface ReleaseFinding {
  readonly code: BomIssueCode | RoutingIssueCode
  readonly lineId: string | null
  readonly size: string | null
  readonly colourwayId: string | null
  readonly stepId: string | null
  readonly message: string
}

/** W1's finding with its cell: a colour of one colour for every colourway lands on the line's colour, not the grid. */
export function fromRelease(finding: ReleaseFinding, severity: BomCheckSeverity): BomCheckItem {
  const column = (finding.code === 'COLOUR_MISSING' || finding.code === 'COLOUR_ARCHIVED') && finding.colourwayId === null ? 'itemColourId' : W1_COLUMN[finding.code]
  return { code: finding.code, severity, message: finding.message, cell: cellOf({ lineId: finding.lineId, column, size: finding.size, colourwayId: finding.colourwayId, stepId: finding.stepId }) }
}

// ---- the structure's findings ------------------------------------------------------------------------------------------

export interface StructureLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly uom: Uom
  readonly sizeDependent: boolean
  readonly sizes: readonly SizeQuantity[]
  /** Only in this colourway; null: every colourway. */
  readonly colourwayId: string | null
  readonly section: BomSection | null
  readonly parentLineId: string | null
  readonly subAssemblyRevisionId: string | null
  readonly customerSupplied: boolean
}

export interface StructureMaterial {
  readonly id: string
  readonly code: string
  readonly kind: ItemKind
  readonly sourcing: ItemSourcing
  readonly status: MaterialStatus
  readonly approval: MaterialApproval
  readonly isPpeComponent: boolean
  readonly units: ItemUnits
}

export interface StructureAlternate {
  readonly id: string
  readonly lineId: string
  readonly priority: number
  readonly code: string
  readonly status: MaterialStatus
  readonly approval: MaterialApproval
}

export interface StructureFacts {
  readonly lines: readonly StructureLine[]
  readonly materials: ReadonlyMap<string, StructureMaterial>
  readonly alternates: readonly StructureAlternate[]
  /** The style that uses the BOM: its range, every colourway (archived ones too) and whether it is PPE. */
  readonly style: { readonly id: string; readonly sizes: readonly string[]; readonly colourways: readonly BomColourway[]; readonly ppe: boolean }
  /** The sub-assembly revisions the lines name, by revision id (one not read is missing). */
  readonly subAssemblies: ReadonlyMap<string, SubAssemblyTarget>
  /** The circle and depth verdict of each sub-assembly line, by line id. */
  readonly circles: ReadonlyMap<string, CircleVerdict>
  /** A style's code by id (for a circle's words). */
  readonly codeOf: (styleId: string) => string
}

/** The sizes of the range a line asks something for: every size, or a size-dependent line's sizes above 0. */
function sizesUsed(line: StructureLine, range: readonly string[]): string[] {
  if (!line.sizeDependent) return [...range]
  const of = new Map(line.sizes.map((row) => [row.size, row.qty]))
  return range.filter((size) => of.has(size) && !decimalOf(of.get(size)!).isZero())
}

/** The structure's blockers and warnings, line by line in BOM order. */
export function structureIssues(facts: StructureFacts): BomCheck {
  const blockers: BomCheckItem[] = []
  const warnings: BomCheckItem[] = []
  const block = (code: (typeof STRUCTURE_BLOCKERS)[number], message: string, at: Partial<BomCheckCell>) => blockers.push({ code, severity: 'BLOCKER', message, cell: cellOf(at) })
  const warn = (code: (typeof STRUCTURE_WARNINGS)[number], message: string, at: Partial<BomCheckCell>) => warnings.push({ code, severity: 'WARNING', message, cell: cellOf(at) })
  const activeColourways = facts.style.colourways.filter((colourway) => colourway.status === 'ACTIVE')

  for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
    const material = facts.materials.get(line.itemId)
    if (!material) throw new Error(`structureIssues: material ${line.itemId} of line ${line.id} was not read`)
    const name = `Line ${line.seq} (${material.code})`
    const lineId = line.id

    if (material.approval === 'BLOCKED') block('MATERIAL_BLOCKED', `${name}: the material is blocked (refused for use); choose another one.`, { lineId, column: 'itemId' })
    const ppeLine = facts.style.ppe && (material.isPpeComponent || line.section === 'PROTECTION')
    if (ppeLine && material.approval === 'PENDING') {
      warn('PPE_MATERIAL_NOT_APPROVED', `${name}: a PPE line whose material is not approved yet; approve it, or take an approved one.`, { lineId, column: 'itemId' })
    }
    if (line.parentLineId !== null && inGroupCircle(facts.lines, line.id)) {
      block('GROUP_CIRCLE', `${name}: it is grouped under a line that is grouped under it (a circle); ungroup one of them.`, { lineId, column: 'parentLineId' })
    }

    for (const alternate of facts.alternates.filter((entry) => entry.lineId === line.id).sort((a, b) => a.priority - b.priority)) {
      const at = { lineId, column: 'alternates' as const, alternateId: alternate.id }
      if (alternate.approval === 'BLOCKED') block('ALTERNATE_BLOCKED', `${name}: alternate ${alternate.priority} (${alternate.code}) is a blocked material; remove it or take another one.`, at)
      else if (alternate.status !== 'ACTIVE') warn('ALTERNATE_ARCHIVED', `${name}: alternate ${alternate.priority} (${alternate.code}) is archived, so it is never taken; remove it or take another one.`, at)
    }

    if (line.subAssemblyRevisionId === null) continue
    const at = { lineId, column: 'subAssembly' as const }
    const target = facts.subAssemblies.get(line.subAssemblyRevisionId)
    if (!target) {
      block('SUB_ASSEMBLY_NOT_RELEASED', `${name}: its sub-assembly revision cannot be read; take a released revision you can see.`, at)
      continue
    }
    const part = `${target.code} revision ${target.revision}`
    if (target.status === 'DRAFT') {
      block('SUB_ASSEMBLY_NOT_RELEASED', `${name}: it takes sub-assembly ${part}, which is a draft. Release ${part} first, or take its released revision (no draft part under a released parent).`, at)
    } else if (target.status === 'OBSOLETE') {
      block('SUB_ASSEMBLY_NOT_RELEASED', `${name}: it takes sub-assembly ${part}, which is obsolete. Take the released revision of ${target.code}.`, at)
    }
    if (target.styleStatus === 'ARCHIVED') warn('SUB_ASSEMBLY_STYLE_ARCHIVED', `${name}: sub-assembly ${target.code} is an archived style.`, at)
    const madeProblem = subAssemblyMaterialProblem({ seq: line.seq, styleId: facts.style.id, uom: line.uom, customerSupplied: line.customerSupplied, material })
    if (madeProblem) {
      const made = material.kind === 'COMPONENT' && material.sourcing !== 'BUY'
      const counted = (SUB_ASSEMBLY_UOMS as readonly Uom[]).includes(line.uom)
      block('SUB_ASSEMBLY_NOT_MADE', madeProblem, { lineId, column: !made ? 'itemId' : !counted ? 'uom' : 'subAssembly' })
    }
    const verdict = facts.circles.get(line.id)
    const circle = verdict ? circleProblem(line.seq, target, verdict, facts.codeOf) : null
    if (circle) block(verdict!.circleStyleId !== null ? 'SUB_ASSEMBLY_CIRCLE' : 'SUB_ASSEMBLY_TOO_DEEP', circle, at)
    if (outputBatches(line.uom, material.units, target) === null) {
      block('SUB_ASSEMBLY_UNIT', `${name}: it counts ${target.code} in ${UNITS[line.uom].symbol} and the BOM of ${part} makes ${target.outputQuantity} ${UNITS[target.outputUom].symbol}: ${material.code} does not convert one to the other. Change the line's unit.`, { lineId, column: 'uom' })
    }
    for (const size of sizesUsed(line, facts.style.sizes)) {
      if (subAssemblySize(size, target) === null) {
        block('SUB_ASSEMBLY_SIZE_MISSING', `${name}: ${target.code} has no size ${size} (its range: ${target.sizes.join(', ') || 'none'}). Add size ${size} to ${target.code}, or give line ${line.seq} 0 in size ${size}.`, { lineId, column: 'sizes', size })
      }
    }
    for (const colourway of activeColourways) {
      if (line.colourwayId !== null && line.colourwayId !== colourway.id) continue
      if (subAssemblyColourway(colourway.code, target) === null) {
        block('SUB_ASSEMBLY_COLOURWAY_MISSING', `${name}: ${target.code} has no active colourway ${colourway.code}, nor one only colourway to take. Add colourway ${colourway.code} to ${target.code}.`, { lineId, column: 'subAssembly', colourwayId: colourway.id })
      }
    }
  }
  return { blockers, warnings }
}

// ---- the whole check ---------------------------------------------------------------------------------------------------

/**
 * The BOM check: W1's findings (with their cells) and the structure's, in the order a person fixes them: the revision's
 * own first (no line), then line by line in BOM order (W1's before the structure's on one line), the routing last.
 */
export function bomCheck(release: { readonly blockers: readonly ReleaseFinding[]; readonly warnings: readonly ReleaseFinding[] }, structure: BomCheck, seqOf: (lineId: string) => number | undefined): BomCheck {
  const rank = (item: BomCheckItem): number => (item.cell.stepId !== null || item.cell.column === 'routing' ? Number.MAX_SAFE_INTEGER : item.cell.lineId === null ? -1 : (seqOf(item.cell.lineId) ?? Number.MAX_SAFE_INTEGER - 1))
  const ordered = (items: BomCheckItem[]) => items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map((entry) => entry.item)
  return {
    blockers: ordered([...release.blockers.map((finding) => fromRelease(finding, 'BLOCKER')), ...structure.blockers]),
    warnings: ordered([...release.warnings.map((finding) => fromRelease(finding, 'WARNING')), ...structure.warnings]),
  }
}

/** The release's refusal issues of the structure's blockers (W1's keep their own paths): `lines/<id>/<column>[/<size | colourway | alternate>]`. */
export function structureRefusalIssues(blockers: readonly BomCheckItem[]): { path: string; message: string }[] {
  return blockers.map((item) => {
    const { cell } = item
    if (cell.lineId === null) return { path: `bom/${item.code}`, message: item.message }
    const tail = cell.alternateId !== null ? `/${cell.alternateId}` : cell.size !== null ? `/${cell.size}` : cell.colourwayId !== null ? `/${cell.colourwayId}` : ''
    return { path: `lines/${cell.lineId}/${cell.column ?? item.code}${tail}`, message: item.message }
  })
}

import type { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import type { ItemKind, ItemSourcing } from '../materials/rules'
import type { MasterStatus } from '../sizes/rules'
import type { RevisionStatus } from '../styles/revisions'
import type { StyleStatus } from '../styles/rules'
import { baseFactor, UNITS, type ItemUnits, type Uom } from '../units/units'

/**
 * The structure of a style revision's BOM (B-W2b-223; features PRD-077, PRD-078, PRD-106), pure. B-W2b-211's columns on
 * W1's BomLine (`section`, `parentLineId`, `subAssemblyStyleId` + `subAssemblyRevisionId`), read and written by
 * apps/factory-api's modules/product/bom-structure; the …_bom_options_w2b_guards migration holds the same rules for every
 * login, so the API says them in words first and the database's refusal never reaches a person.
 *
 *   section       the part of the BOM a line is filed under (shell, lining, insulation, protection, trims, thread, labels,
 *                 packaging, other: PRD-077); a line not filed yet (every line before W2b-4) is shown under its material's
 *                 kind's section (`sectionOf`) until a person files it
 *   group row     a line may be grouped under another line of the same revision (a protector with its pocket and its
 *                 hook-and-loop): never under itself nor under a line grouped under it; grouping moves no quantity (every
 *                 line's quantity is per output unit of the revision); a group row is not removed while lines are grouped
 *                 under it
 *   sub-assembly  a line may take a revision of ANOTHER style as a part we make once and use in several garments (a
 *                 removable liner, an armour insert, a hump: PRD-078): the line's material is then the COMPONENT we make
 *                 (sourcing MAKE or MAKE_OR_BUY) counted in PCS, PAIR or SET, never sent by the customer; the revision is
 *                 DRAFT or RELEASED when it is named and RELEASED when this revision is released (no draft part under a
 *                 released parent: PRD-106); no style is inside its own sub-assemblies (a circle) and a BOM has at most
 *                 MAX_BOM_LEVELS levels
 *
 * A sub-assembly serves each size and colourway of its parent with one of its own (`subAssemblySize`,
 * `subAssemblyColourway`): the same size code (else its only size) and the same colourway code (else its only active
 * colourway); one that cannot is a problem of the BOM check (./check). Its own BOM makes `outputQuantity` units of
 * `outputUom`: one unit of the parent's line is `outputBatches` of it.
 */

/** BOM sections (factory-db enum BomSection), in the order a BOM is read. */
export const BOM_SECTIONS = ['SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'TRIMS', 'THREAD', 'LABELS', 'PACKAGING', 'OTHER'] as const
export type BomSection = (typeof BOM_SECTIONS)[number]

/** A section in the API's words (screens say their own). */
export const SECTION_WORDS: Readonly<Record<BomSection, string>> = {
  SHELL: 'shell',
  LINING: 'lining',
  INSULATION: 'insulation',
  PROTECTION: 'protection',
  TRIMS: 'trims',
  THREAD: 'thread',
  LABELS: 'labels',
  PACKAGING: 'packaging',
  OTHER: 'other',
}

/** The section a line of this kind of material is shown under while it is not filed. */
export const SECTION_OF_KIND: Readonly<Record<ItemKind, BomSection>> = {
  LEATHER: 'SHELL',
  TEXTILE: 'SHELL',
  LINING: 'LINING',
  MEMBRANE: 'INSULATION',
  PADDING: 'INSULATION',
  THREAD: 'THREAD',
  TRIM: 'TRIMS',
  HARDWARE: 'TRIMS',
  PROTECTOR: 'PROTECTION',
  LABEL: 'LABELS',
  PACKAGING: 'PACKAGING',
  COMPONENT: 'OTHER',
}

/** The section a line is shown under: its own, else its material's kind's (`filed` false). */
export function sectionOf(filed: BomSection | null, kind: ItemKind): { readonly section: BomSection; readonly filed: boolean } {
  return filed === null ? { section: SECTION_OF_KIND[kind], filed: false } : { section: filed, filed: true }
}

/** A material's approval for use (factory-db enum MaterialApproval, B-W2b-206). */
export const MATERIAL_APPROVALS = ['PENDING', 'APPROVED', 'CONDITIONAL', 'BLOCKED'] as const
export type MaterialApproval = (typeof MATERIAL_APPROVALS)[number]
/** Approved for use: APPROVED, or CONDITIONAL (approved on its condition). */
export const isApproved = (approval: MaterialApproval): boolean => approval === 'APPROVED' || approval === 'CONDITIONAL'

/** The units a sub-assembly is counted in on its parent's line, and the units its own BOM makes. */
export const SUB_ASSEMBLY_UOMS = ['PCS', 'PAIR', 'SET'] as const satisfies readonly Uom[]
/** From the top revision to its deepest part (the database's rule). */
export const MAX_BOM_LEVELS = 10

// ---- group rows ------------------------------------------------------------------------------------------------------

export interface GroupLine {
  readonly id: string
  readonly seq: number
  readonly parentLineId: string | null
}

/** The line it is grouped under, walked up (nearest first); stops at a circle (the database never stores one). */
export function groupChain(lines: readonly GroupLine[], lineId: string): GroupLine[] {
  const byId = new Map(lines.map((line) => [line.id, line]))
  const chain: GroupLine[] = []
  const seen = new Set<string>([lineId])
  let parentId = byId.get(lineId)?.parentLineId ?? null
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId)
    if (!parent) break
    chain.push(parent)
    seen.add(parentId)
    parentId = parent.parentLineId
  }
  return chain
}

/** True when the line's group rows lead back to itself (a circle). */
export function inGroupCircle(lines: readonly GroupLine[], lineId: string): boolean {
  const byId = new Map(lines.map((line) => [line.id, line]))
  const seen = new Set<string>()
  let at: string | null = byId.get(lineId)?.parentLineId ?? null
  while (at !== null && !seen.has(at)) {
    if (at === lineId) return true
    seen.add(at)
    at = byId.get(at)?.parentLineId ?? null
  }
  return false
}

/** Why `lineId` cannot be grouped under `parentLineId`, in words (null: it can, or it is ungrouped). */
export function groupProblem(lines: readonly GroupLine[], lineId: string, parentLineId: string | null): string | null {
  if (parentLineId === null) return null
  const line = lines.find((entry) => entry.id === lineId)
  const name = line ? `Line ${line.seq}` : 'This line'
  if (parentLineId === lineId) return `${name} cannot be grouped under itself.`
  const parent = lines.find((entry) => entry.id === parentLineId)
  if (!parent) return 'That line is not in this BOM: group a line under another line of the same revision.'
  if (parent.id === lineId || groupChain(lines, parent.id).some((above) => above.id === lineId)) {
    return `${name} cannot be grouped under line ${parent.seq}: line ${parent.seq} is grouped under it (a circle). Ungroup line ${parent.seq} first.`
  }
  return null
}

/** The lines grouped directly under this one, in BOM order. */
export const groupedUnder = <Line extends GroupLine>(lines: readonly Line[], lineId: string): Line[] => lines.filter((line) => line.parentLineId === lineId).sort((a, b) => a.seq - b.seq)

/**
 * The lines in the order a grouped BOM is read: each line followed by the lines grouped under it (depth first, BOM order
 * among siblings), with its depth (0: not grouped). A line whose group row is not among `lines` is read as not grouped.
 */
export function groupOrder<Line extends GroupLine>(lines: readonly Line[]): { readonly line: Line; readonly depth: number }[] {
  const ids = new Set(lines.map((line) => line.id))
  const out: { line: Line; depth: number }[] = []
  const placed = new Set<string>()
  const visit = (line: Line, depth: number) => {
    if (placed.has(line.id)) return
    placed.add(line.id)
    out.push({ line, depth })
    for (const child of groupedUnder(lines, line.id)) visit(child, depth + 1)
  }
  for (const root of [...lines].filter((line) => line.parentLineId === null || !ids.has(line.parentLineId)).sort((a, b) => a.seq - b.seq)) visit(root, 0)
  // A circle (never stored) leaves its lines unplaced: read them last, ungrouped.
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) if (!placed.has(line.id)) visit(line, 0)
  return out
}

/** Why this line cannot be removed now: lines are grouped under it (null: it can). */
export function removeGroupRowProblem(lines: readonly GroupLine[], lineId: string): string | null {
  const line = lines.find((entry) => entry.id === lineId)
  const under = groupedUnder(lines, lineId)
  if (!line || under.length === 0) return null
  const seqs = under.map((entry) => entry.seq).join(', ')
  return `Line ${line.seq} is the group row of line${under.length === 1 ? '' : 's'} ${seqs}: ungroup ${under.length === 1 ? 'it' : 'them'} (or remove ${under.length === 1 ? 'it' : 'them'}) first.`
}

// ---- sub-assemblies ----------------------------------------------------------------------------------------------------

/** The revision of another style a line takes as a sub-assembly, as the rules read it. */
export interface SubAssemblyTarget {
  readonly styleId: string
  readonly code: string
  readonly styleStatus: StyleStatus
  readonly revisionId: string
  readonly revision: number
  readonly status: RevisionStatus
  /** The sub-assembly style's range, in its scale's order. */
  readonly sizes: readonly string[]
  /** Every colourway of the sub-assembly style, archived ones too. */
  readonly colourways: readonly { readonly id: string; readonly code: string; readonly status: MasterStatus }[]
  /** What its BOM makes: outputQuantity units of outputUom. */
  readonly outputQuantity: number
  readonly outputUom: Uom
}

/** The line that would take it, and its material. */
export interface SubAssemblyLine {
  readonly seq: number
  /** The line's own style (a style is never its own sub-assembly). */
  readonly styleId: string
  readonly uom: Uom
  readonly customerSupplied: boolean
  readonly material: { readonly code: string; readonly kind: ItemKind; readonly sourcing: ItemSourcing }
}

/** Why the line's material cannot carry a sub-assembly (words), or null. */
export function subAssemblyMaterialProblem(line: SubAssemblyLine): string | null {
  const { material } = line
  if (material.kind !== 'COMPONENT' || material.sourcing === 'BUY') {
    return `Line ${line.seq} takes ${material.code} (${material.kind.toLowerCase()}, ${material.sourcing === 'BUY' ? 'bought' : 'made'}): a sub-assembly line takes the COMPONENT we make (sourcing MAKE or MAKE_OR_BUY). Choose that component as the line's material first.`
  }
  if (!(SUB_ASSEMBLY_UOMS as readonly Uom[]).includes(line.uom)) {
    return `Line ${line.seq} counts in ${UNITS[line.uom].symbol}: a sub-assembly is counted in pieces, pairs or sets (PCS, PAIR or SET). Change the line's unit first.`
  }
  if (line.customerSupplied) return `Line ${line.seq} is sent by the customer: a sub-assembly is one we make. Clear the customer first.`
  return null
}

/**
 * Every reason this line cannot take this revision as its sub-assembly now (paths relative to the body's `subAssembly`),
 * as the database's rule would refuse it; the circle and the depth are `subAssemblyCircle`'s.
 */
export function subAssemblyProblems(line: SubAssemblyLine, target: SubAssemblyTarget): Issue[] {
  const issues: Issue[] = []
  if (target.styleId === line.styleId) {
    issues.push({ path: 'styleId', message: `A style is never its own sub-assembly: choose another style's revision for line ${line.seq}.` })
    return issues
  }
  const material = subAssemblyMaterialProblem(line)
  if (material) issues.push({ path: 'styleId', message: material })
  if (target.status === 'OBSOLETE') {
    issues.push({ path: 'revisionId', message: `Revision ${target.revision} of ${target.code} is obsolete: take its released revision (or its draft).` })
  }
  return issues
}

/** A sub-assembly link of the tenant: a line of `fromRevisionId` (of `fromStyleId`) takes `toRevisionId` (of `toStyleId`). */
export interface SubAssemblyEdge {
  readonly fromRevisionId: string
  readonly fromStyleId: string
  readonly toRevisionId: string
  readonly toStyleId: string
}

export interface CircleVerdict {
  /** A style that would be inside its own sub-assemblies (null: none). */
  readonly circleStyleId: string | null
  /** The levels of the deepest BOM it would make, from the top revision that uses `at` to the deepest part (1: no sub-assembly). */
  readonly levels: number
}

/**
 * The database's circle and depth rule for a line of revision `at` taking revision `target`, on the tenant's sub-assembly
 * links (`edges`, the line's own left out): the styles ABOVE the line (its own, and every style whose revisions use its
 * revision, walked up) against the styles INSIDE the target (the target's own and its sub-assemblies', walked down), each
 * walk stopping at MAX_BOM_LEVELS.
 */
export function subAssemblyCircle(at: { readonly revisionId: string; readonly styleId: string }, target: { readonly revisionId: string; readonly styleId: string }, edges: readonly SubAssemblyEdge[]): CircleVerdict {
  const usedBy = new Map<string, SubAssemblyEdge[]>()
  const contains = new Map<string, SubAssemblyEdge[]>()
  for (const edge of edges) {
    usedBy.set(edge.toRevisionId, [...(usedBy.get(edge.toRevisionId) ?? []), edge])
    contains.set(edge.fromRevisionId, [...(contains.get(edge.fromRevisionId) ?? []), edge])
  }
  // Up: depth 0 = the line's revision.
  const above = new Map<string, number>([[at.styleId, 0]])
  let highest = 0
  let frontier = [{ revisionId: at.revisionId, depth: 0 }]
  const seenUp = new Set<string>([at.revisionId])
  while (frontier.length > 0) {
    const next: typeof frontier = []
    for (const node of frontier) {
      if (node.depth >= MAX_BOM_LEVELS) continue
      for (const edge of usedBy.get(node.revisionId) ?? []) {
        const depth = node.depth + 1
        highest = Math.max(highest, depth)
        if (!above.has(edge.fromStyleId)) above.set(edge.fromStyleId, depth)
        if (!seenUp.has(edge.fromRevisionId)) {
          seenUp.add(edge.fromRevisionId)
          next.push({ revisionId: edge.fromRevisionId, depth })
        }
      }
    }
    frontier = next
  }
  // Down: depth 1 = the target.
  let circleStyleId: string | null = above.has(target.styleId) ? target.styleId : null
  let deepest = 1
  let down = [{ revisionId: target.revisionId, depth: 1 }]
  const seenDown = new Set<string>([target.revisionId])
  while (down.length > 0) {
    const next: typeof down = []
    for (const node of down) {
      if (node.depth >= MAX_BOM_LEVELS) continue
      for (const edge of contains.get(node.revisionId) ?? []) {
        const depth = node.depth + 1
        deepest = Math.max(deepest, depth)
        if (circleStyleId === null && above.has(edge.toStyleId)) circleStyleId = edge.toStyleId
        if (!seenDown.has(edge.toRevisionId)) {
          seenDown.add(edge.toRevisionId)
          next.push({ revisionId: edge.toRevisionId, depth })
        }
      }
    }
    down = next
  }
  return { circleStyleId, levels: highest + 1 + deepest }
}

/** The circle verdict in words for line `seq` taking `target` (null: neither a circle nor too deep). */
export function circleProblem(seq: number, target: Pick<SubAssemblyTarget, 'code' | 'revision'>, verdict: CircleVerdict, codeOf: (styleId: string) => string): string | null {
  if (verdict.circleStyleId !== null) {
    return `Line ${seq} cannot take ${target.code} revision ${target.revision}: ${codeOf(verdict.circleStyleId)} would be inside its own sub-assemblies (a circle).`
  }
  if (verdict.levels > MAX_BOM_LEVELS) {
    return `Line ${seq} cannot take ${target.code} revision ${target.revision}: the BOM would have ${verdict.levels} levels, at most ${MAX_BOM_LEVELS} (sub-assemblies inside sub-assemblies).`
  }
  return null
}

/** The size of the sub-assembly that serves a size of its parent: the same code, else its only size; null: none. */
export function subAssemblySize(size: string, target: Pick<SubAssemblyTarget, 'sizes'>): string | null {
  if (target.sizes.includes(size)) return size
  return target.sizes.length === 1 ? target.sizes[0]! : null
}

/** The colourway of the sub-assembly that serves a colourway of its parent: the same code (active), else its only active one. */
export function subAssemblyColourway(colourwayCode: string, target: Pick<SubAssemblyTarget, 'colourways'>): { readonly id: string; readonly code: string } | null {
  const active = target.colourways.filter((colourway) => colourway.status === 'ACTIVE')
  const same = active.find((colourway) => colourway.code === colourwayCode)
  if (same) return { id: same.id, code: same.code }
  return active.length === 1 ? { id: active[0]!.id, code: active[0]!.code } : null
}

/**
 * How many of the sub-assembly's output batches (`outputQuantity` × `outputUom`) one unit of the line's unit is, exact, in
 * the units of the line's material (the component): 1 PAIR on the line of a sub-assembly that makes 1 PCS is 2 batches.
 * null: the line's unit and the output's unit do not convert in the component's units.
 */
export function outputBatches(lineUom: Uom, units: ItemUnits, target: Pick<SubAssemblyTarget, 'outputQuantity' | 'outputUom'>): Decimal | null {
  const line = baseFactor(lineUom, units)
  const output = baseFactor(target.outputUom, units)
  if (line === null || output === null || output.isZero() || target.outputQuantity < 1) return null
  return line.div(output).div(target.outputQuantity)
}

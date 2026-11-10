import { BOM_BLOCKERS, BOM_WARNINGS } from '@nexus/factory-domain/product/bom/rules'
import { ROUTING_ISSUE_CODES } from '@nexus/factory-domain/product/routing/rules'
import { ALTERNATE_NOTE_MAX, ALTERNATE_USES, MAX_ALTERNATES, type AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import { STRUCTURE_BLOCKERS, STRUCTURE_WARNINGS } from '@nexus/factory-domain/product/bom-structure/check'
import { BOM_SECTIONS, groupChain, SUB_ASSEMBLY_UOMS, type BomSection } from '@nexus/factory-domain/product/bom-structure/rules'
import type { BomLine, BomView, MaterialRow, StyleRow, StyleView } from '../../api'
import { decimalInput } from '../../model'
import type { PiecesView } from '../../record/pieces/api'
import type { Alternate, AlternateBody, BomDepthView, BomStructureView, CheckItem, DepthLine, PartyRow, StructureLine, StyleOptionsView, TreeNode, UsedInView } from './api'

/**
 * The BOM in depth, its rules (B-W2b-241; design products.styles › Materials (BOM): "Section (…; W2b group rows)",
 * "Alternates (W2b)", "Customer-supplied (W2b)", "Option (W2b)", the BOM check's "Archived or blocked material (W2b)" and
 * "Circular sub-assembly (W2b)", the view switch's Tree, "Fill from base by increment" by size, the leather section's "Grade
 * mix and minimum grade per pattern piece", the line's "Alternates (W2b)"), pure: the rows of the Lines view (W1's line, its
 * structure, its depth and its option in one), the check's findings with where "Show me" lands, the reasons a write is held,
 * an alternate's change as the API takes it, the leather grade mix of the pattern pieces. The views and the container use
 * these; the tests hold them.
 */

export type Part<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface SearchState<T> {
  query: string
  results: T[] | null
  problem: string | null
}

/** The part of the line drawer: its structure and supply (section, group row, sub-assembly, customer, workshop, option), or its alternates. */
export type LinePart = 'structure' | 'alternates'

/** The pop-ups of the BOM in depth (one at a time; the studio's own dialogs stay its own). */
export type BomDepthDialog =
  | { kind: 'line'; lineId: string; part: LinePart }
  | { kind: 'section'; lineIds: string[] }
  | { kind: 'group'; lineIds: string[] }
  | { kind: 'supply'; lineIds: string[] }
  | { kind: 'fill'; lineId: string }
  | { kind: 'removeAlternate'; lineId: string; alternateId: string }

/** A cell's or a field's save: saving (sent), waiting (offline, kept on this page), refused (our words); nothing once saved. */
export interface CellMark {
  state: 'saving' | 'waiting' | 'refused'
  value?: string | null
  problem?: string
}

export interface DepthNotice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

/** The chosen sub-assembly style, read for its revisions (the line drawer's second step). */
export type SubStyle = Pick<StyleView, 'id' | 'code' | 'name' | 'status' | 'revisions'>

export interface BomDepthModel {
  structure: Part<BomStructureView>
  depth: Part<BomDepthView>
  /** The options the style offers and its option lines (GET /product/styles/:id/options). */
  options: Part<StyleOptionsView>
  /** The revisions of other styles that take this one as a sub-assembly (read with the Tree view). */
  usedIn: Part<UsedInView>
  dialog: BomDepthDialog | null
  busy: boolean
  /** The Lines view's selection (line ids). */
  selected: string[]
  /** `${lineId}:${size}` (By size), `${lineId}:${field}` (the line drawer), `${alternateId}:${field}` (an alternate). */
  marks: Record<string, CellMark>
  notice: DepthNotice | null
  /** The last write the server refused while a pop-up is open: our words (a `products` problem key) and the API's sentence. */
  refusal: { key: string; detail: string | null } | null
  offline: boolean
  canManage: boolean
  customers: SearchState<PartyRow>
  styles: SearchState<StyleRow>
  /** The sub-assembly style picked in the line drawer (its revisions). */
  subStyle: Part<SubStyle> | null
  /** The material search of "Add alternate". */
  materials: SearchState<MaterialRow>
  /** "Show me" on a size: the By size cell to focus. */
  focus?: { lineId: string; size: string } | null
}

export interface BomDepthActions {
  onRetry?: () => void
  onDialog?: (dialog: BomDepthDialog | null) => void
  onSelect?: (ids: string[]) => void
  onDismissNotice?: () => void
  onStructure?: (lineId: string, body: { section?: BomSection | null; parentLineId?: string | null; subAssembly?: { styleId: string; revisionId: string } | null }, field: string) => Promise<boolean>
  onChangeStructure?: (lineIds: string[], body: { section?: BomSection | null; parentLineId?: string | null }) => Promise<boolean>
  onSupply?: (lineId: string, body: { customerSuppliedByPartyId?: string | null; issueToSubcontract?: boolean }, field: string) => Promise<boolean>
  onChangeSupply?: (lineIds: string[], body: { customerSuppliedByPartyId?: string | null; issueToSubcontract?: boolean }) => Promise<boolean>
  onOption?: (lineId: string, optionValueId: string | null) => Promise<boolean>
  onAddAlternate?: (lineId: string, body: AlternateBody & { itemId: string }) => Promise<boolean>
  onAlternate?: (lineId: string, alternateId: string, body: AlternateBody, field: string) => Promise<boolean>
  onRemoveAlternate?: (lineId: string, alternateId: string) => Promise<boolean>
  onMoveAlternate?: (lineId: string, alternateId: string, delta: -1 | 1) => Promise<boolean>
  onSizeCell?: (lineId: string, size: string, value: string | null) => void
  onFill?: (lineId: string, sizes: Array<{ size: string; qty: string }>) => Promise<boolean>
  onFindCustomers?: (query: string) => void
  onFindStyles?: (query: string) => void
  onPickStyle?: (styleId: string | null) => void
  onFindMaterials?: (query: string) => void
  onLoadUsedIn?: () => void
  /** "Show me" on a size: the By size cell to focus (then `onFocused`). */
  onShowSize?: (lineId: string, size: string) => void
  onFocused?: () => void
}

/** The empty model (nothing read yet). */
export const NO_BOM_DEPTH: BomDepthModel = {
  structure: { status: 'idle' },
  depth: { status: 'idle' },
  options: { status: 'idle' },
  usedIn: { status: 'idle' },
  dialog: null,
  busy: false,
  selected: [],
  marks: {},
  notice: null,
  refusal: null,
  offline: false,
  canManage: false,
  customers: { query: '', results: null, problem: null },
  styles: { query: '', results: null, problem: null },
  subStyle: null,
  materials: { query: '', results: null, problem: null },
}

export const ready = <T>(part: Part<T> | undefined): T | null => (part && part.status === 'ready' ? part.value : null)

export { BOM_SECTIONS, ALTERNATE_USES, ALTERNATE_NOTE_MAX, MAX_ALTERNATES }

// ---- who may change the BOM in depth now ------------------------------------------------------------------------------

/** Why the BOM's structure, supply, options and alternates cannot be changed now (a key of this catalogue), or null. */
export function depthHeld(structure: Pick<BomStructureView, 'editable' | 'revision' | 'style'> | null, canManage: boolean, offline: boolean, busy: boolean): string | null {
  if (!canManage) return 'hold.noManage'
  if (!structure) return 'hold.loading'
  if (structure.style.status === 'ARCHIVED') return 'hold.archived'
  if (structure.revision.status !== 'DRAFT' || !structure.editable) return 'hold.frozen'
  if (offline) return 'hold.offline'
  if (busy) return 'hold.busy'
  return null
}

// ---- the Lines view's rows ----------------------------------------------------------------------------------------------

export interface LineRow {
  id: string
  seq: number
  /** W1's line (quantities, colours, the operation). */
  line: BomLine
  /** Its structure (section, group row, sub-assembly); null until read. */
  structure: StructureLine | null
  /** Its depth (alternates, who sends it, the workshop); null until read. */
  depth: DepthLine | null
  /** Its depth in the group rows (0: not grouped). */
  level: number
  /** The option it is only for, as the page names it ("Perforation: Full"); null: every garment. */
  option: { label: string; valueId: string } | null
}

type Offer = StyleOptionsView['offers'][number]

/** An option value as the page names it: "Group: Value" (Italian or English names when the library has them). */
export function optionLabel(offers: readonly Offer[], valueId: string, locale: 'it' | 'en'): string | null {
  for (const offer of offers) {
    const value = offer.values.find((entry) => entry.id === valueId)
    if (value) return `${offer.group.nameI18n?.[locale] ?? offer.group.name}: ${value.nameI18n?.[locale] ?? value.name}`
  }
  return null
}

/**
 * The Lines view: the structure's grouped order (each group row followed by its lines, depth first) once read, else W1's
 * order; each W1 line with its structure, its depth and its option. A line the structure does not know yet (a write in
 * between) comes last, ungrouped.
 */
export function lineRows(bom: Pick<BomView, 'lines'>, structure: Pick<BomStructureView, 'lines'> | null, depth: Pick<BomDepthView, 'lines'> | null, options: Pick<StyleOptionsView, 'offers' | 'lines'> | null, locale: 'it' | 'en'): LineRow[] {
  const byId = new Map(bom.lines.map((line) => [line.id, line]))
  const order = structure ? structure.lines.filter((entry) => byId.has(entry.id)).map((entry) => entry.id) : []
  for (const line of bom.lines) if (!order.includes(line.id)) order.push(line.id)
  return order.map((id) => {
    const line = byId.get(id)!
    const own = structure?.lines.find((entry) => entry.id === id) ?? null
    const valueId = own?.optionValueId ?? null
    const listed = valueId ? (options?.lines.find((entry) => entry.lineId === id) ?? null) : null
    const label = valueId ? (options ? optionLabel(options.offers, valueId, locale) : null) ?? listed?.option ?? null : null
    return {
      id,
      seq: line.seq,
      line,
      structure: own,
      depth: depth?.lines.find((entry) => entry.id === id) ?? null,
      level: own?.depth ?? 0,
      option: valueId ? { label: label ?? '—', valueId } : null,
    }
  })
}

/** "20 · SEED-LIN-200". */
export const lineName = (line: { readonly seq: number; readonly item: { readonly code: string } }): string => `${line.seq} · ${line.item.code}`

/** The lines another may be grouped under: not itself, not one grouped (at any depth) under it. */
export function groupChoices(lines: readonly Pick<StructureLine, 'id' | 'seq' | 'parentLineId' | 'item'>[], lineIds: readonly string[]): Pick<StructureLine, 'id' | 'seq' | 'item'>[] {
  const picked = new Set(lineIds)
  return [...lines]
    .filter((line) => !picked.has(line.id) && !groupChain(lines, line.id).some((above) => picked.has(above.id)))
    .sort((a, b) => a.seq - b.seq)
}

// ---- the sub-assembly and the customer of a line ------------------------------------------------------------------------

/** Why this line cannot take a sub-assembly (a key), or null: the COMPONENT we make, counted in pieces, pairs or sets, not the customer's. */
export function subAssemblyHeld(line: Pick<StructureLine, 'item' | 'uom' | 'customerSuppliedByPartyId'>): string | null {
  if (line.item.kind !== 'COMPONENT' || line.item.sourcing === 'BUY') return 'line.sub.held.notComponent'
  if (!(SUB_ASSEMBLY_UOMS as readonly string[]).includes(line.uom)) return 'line.sub.held.unit'
  if (line.customerSuppliedByPartyId !== null) return 'line.sub.held.customer'
  return null
}

/** Why a customer cannot send this line (a key), or null: a line bought from a supplier, or a sub-assembly we make. */
export function customerHeld(line: Pick<DepthLine, 'supplier' | 'subAssembly'>): string | null {
  if (line.subAssembly) return 'line.customer.held.sub'
  if (line.supplier) return 'line.customer.held.supplier'
  return null
}

/** The selection's supply: the lines a customer cannot send (by name), or none. */
export function supplyBlocked(rows: readonly LineRow[]): string[] {
  return rows.filter((row) => row.depth !== null && customerHeld(row.depth) !== null).map((row) => lineName(row.line))
}

/** The revisions of a style a line may take: released first, then drafts (the check holds a draft), never an obsolete one. */
export function subRevisions(style: SubStyle): SubStyle['revisions'] {
  return [...style.revisions].filter((revision) => revision.status !== 'OBSOLETE').sort((a, b) => (a.status === b.status ? b.revision - a.revision : a.status === 'RELEASED' ? -1 : 1))
}

// ---- the BOM check (THE check, B-W2b-223) -------------------------------------------------------------------------------

/** The structure's own codes (said in this catalogue); W1's codes keep W1's words (products `issue.*`). */
export const STRUCTURE_CODES: readonly string[] = [...STRUCTURE_BLOCKERS, ...STRUCTURE_WARNINGS]
const W1_CODES: readonly string[] = [...BOM_BLOCKERS, ...BOM_WARNINGS]

/** The check's findings this tab shows: the BOM's and the structure's (the routing's are the Operations tab's). */
export function bomFindings(check: Pick<BomStructureView['check'], 'blockers' | 'warnings'>): { blockers: CheckItem[]; warnings: CheckItem[] } {
  const ours = (item: CheckItem) => !(ROUTING_ISSUE_CODES as readonly string[]).includes(item.code)
  return { blockers: check.blockers.filter(ours), warnings: check.warnings.filter(ours) }
}

/** The tab's problem mark: what stops the release on this tab (null until the check is read). */
export function bomMarkCount(structure: Pick<BomStructureView, 'check' | 'revision'> | null): number | null {
  if (!structure || structure.revision.status !== 'DRAFT' || !structure.check.checked) return null
  return bomFindings(structure.check).blockers.length
}

export const isW1Code = (code: string): boolean => W1_CODES.includes(code)

/** A structure finding's words: its key in this catalogue and the names it needs. */
export function structureWords(item: CheckItem, structure: Pick<BomStructureView, 'lines'> | null, depth: Pick<BomDepthView, 'lines'> | null): { key: string; params: Record<string, string> } {
  const line = item.cell.lineId ? structure?.lines.find((entry) => entry.id === item.cell.lineId) : undefined
  const alternate = item.cell.alternateId ? depth?.lines.flatMap((entry) => entry.alternates).find((entry) => entry.id === item.cell.alternateId) : undefined
  return {
    key: `findings.${item.code}`,
    params: {
      line: line ? lineName(line) : '—',
      material: line?.item.code ?? '—',
      sub: line?.subAssembly ? `${line.subAssembly.style.code} r${line.subAssembly.revision.revision}` : '—',
      alternate: alternate ? alternate.item.code : '—',
      size: item.cell.size ?? '—',
    },
  }
}

/** Where "Show me" lands: a view of the tab (a cell in it), the line drawer at its part, W1's line dialog, the planned hide yield. */
export type ShowMe =
  | { to: 'sizes'; lineId: string; size: string }
  | { to: 'colours'; lineId: string; colourwayId: string | null }
  | { to: 'row'; lineId: string }
  | { to: 'line'; lineId: string; part: LinePart }
  | { to: 'edit'; lineId: string }
  | { to: 'yield' }
  | { to: 'add' }

export function showMeOf(item: Pick<CheckItem, 'code' | 'cell'>): ShowMe | null {
  const { cell } = item
  if (item.code === 'NO_LINES') return { to: 'add' }
  if (cell.column === 'plannedHideYieldPct') return { to: 'yield' }
  if (!cell.lineId) return null
  if (cell.size && (cell.column === 'sizes' || cell.column === 'qty' || cell.column === null)) return { to: 'sizes', lineId: cell.lineId, size: cell.size }
  if (cell.column === 'colours' || (cell.colourwayId && cell.column !== 'subAssembly')) return { to: 'colours', lineId: cell.lineId, colourwayId: cell.colourwayId }
  if (cell.column === 'alternates' || cell.alternateId) return { to: 'line', lineId: cell.lineId, part: 'alternates' }
  if (cell.column === 'subAssembly' || cell.column === 'section' || cell.column === 'parentLineId') return { to: 'line', lineId: cell.lineId, part: 'structure' }
  if (cell.column === 'uom' || cell.column === 'qty' || cell.column === 'wastagePct' || cell.column === 'itemColourId' || cell.column === 'colourwayId') return { to: 'edit', lineId: cell.lineId }
  return { to: 'row', lineId: cell.lineId }
}

// ---- alternates -----------------------------------------------------------------------------------------------------------

/** An alternate's typed quantity as the API takes it: a number above 0 ("1,9" or "1.9"), or null (the line's own); undefined: not a number. */
export function alternateQty(text: string): string | null | undefined {
  const value = decimalInput(text, 4)
  if (value === undefined) return undefined
  if (value === null) return null
  return Number(value) > 0 ? value : undefined
}

/** Why an alternate cannot be added to this line now (a key), or null. */
export function addAlternateHeld(line: Pick<DepthLine, 'alternates' | 'subAssembly'>, held: string | null): string | null {
  if (held) return held
  if (line.subAssembly) return 'alt.held.sub'
  if (line.alternates.length >= MAX_ALTERNATES) return 'alt.held.max'
  return null
}

/** The order after a move (null: it is already first or last). */
export function movedOrder(alternates: readonly Pick<Alternate, 'id'>[], alternateId: string, delta: -1 | 1): string[] | null {
  const ids = alternates.map((entry) => entry.id)
  const at = ids.indexOf(alternateId)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return null
  ;[ids[at], ids[to]] = [ids[to]!, ids[at]!]
  return ids
}

/** The certificate check's switch: held on (and why) when a PPE component is involved, else free. */
export const certificateHeld = (alternate: Pick<Alternate, 'certificateRequired'>): string | null => (alternate.certificateRequired ? 'alt.certificateRequired' : null)

export const isAlternateUse = (value: string): value is AlternateUse => (ALTERNATE_USES as readonly string[]).includes(value)

// ---- the sub-assembly tree ----------------------------------------------------------------------------------------------

/** A tree row's id (a line may appear once per path). */
export const treeRowId = (node: Pick<TreeNode, 'via' | 'lineId'>): string => [...node.via, node.lineId].join('>')

// ---- leather: the pattern pieces' minimum grades (B-W2b-95's data) ------------------------------------------------------

export interface GradeMixRow {
  /** null: any grade. */
  grade: { id: string; code: string; label: string } | null
  /** Pieces per garment that need this grade or better (their quantity counted). */
  pieces: number
  /** Their share of the line's pieces per garment, whole percent. */
  pct: number
  names: string[]
}

export interface LeatherPieces {
  pieces: Array<{ id: string; name: string; quantity: number; minGrade: { code: string; label: string } | null; sizes: string[] }>
  mix: GradeMixRow[]
  /** Pieces per garment cut from the line. */
  total: number
}

/**
 * The pattern pieces cut from one leather line and its grade mix: per minimum grade (best first, then "any grade"), the
 * pieces per garment that need it or better and their share. A garment cut from a lower grade than a piece's minimum is
 * refused at cutting (B-W2b-103 `gradeVerdict`); here the mix says what the hides must hold.
 */
export function leatherPieces(view: Pick<PiecesView, 'pieces' | 'grades'>, lineId: string, locale: 'it' | 'en'): LeatherPieces {
  const grades = new Map(view.grades.map((grade) => [grade.id, grade]))
  const label = (grade: PiecesView['grades'][number]) => (locale === 'it' ? grade.labelIt : grade.labelEn)
  const own = view.pieces.filter((piece) => piece.bomLineId === lineId).sort((a, b) => a.seq - b.seq)
  const total = own.reduce((sum, piece) => sum + piece.quantity, 0)
  const groups = new Map<string, GradeMixRow & { order: number }>()
  for (const piece of own) {
    const grade = piece.minGradeId ? (grades.get(piece.minGradeId) ?? null) : null
    const key = grade?.id ?? 'any'
    const row = groups.get(key) ?? { grade: grade ? { id: grade.id, code: grade.code, label: label(grade) } : null, pieces: 0, pct: 0, names: [], order: grade ? grade.sortOrder : Number.MAX_SAFE_INTEGER }
    row.pieces += piece.quantity
    row.names.push(piece.name)
    groups.set(key, row)
  }
  const mix = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...row }) => ({ ...row, pct: total === 0 ? 0 : Math.round((row.pieces * 100) / total) }))
  return {
    pieces: own.map((piece) => {
      const grade = piece.minGradeId ? (grades.get(piece.minGradeId) ?? null) : null
      return { id: piece.id, name: piece.name, quantity: piece.quantity, minGrade: grade ? { code: grade.code, label: label(grade) } : null, sizes: piece.sizes }
    }),
    mix,
    total,
  }
}

// ---- by size ------------------------------------------------------------------------------------------------------------

/** A size of a size-dependent line, its quantity (null: missing). */
export const sizeQty = (line: Pick<BomLine, 'sizes'>, size: string): string | null => line.sizes.find((entry) => entry.size === size)?.qty ?? null

export const markKey = (id: string, field: string): string => `${id}:${field}`

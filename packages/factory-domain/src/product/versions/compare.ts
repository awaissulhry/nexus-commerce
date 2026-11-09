import { decimalOf, decimalText, type Uom } from '../units/units'

/**
 * Two revisions of a style compared, part by part (B-W2b-220; features PRD-168 "compare any two versions: BOM, POMs,
 * routing, labels and options", PRD-085 "BOM versions and compare", follow-up VS1:01 "with the pattern pieces"), pure.
 * The answer is shaped for the design part VersionCompare (B-W2b-207, packages/ui patterns/VersionCompare): per part a
 * section of lines matched across the two revisions, each line's fields WRITTEN (codes and exact decimals, language-free:
 * a material's code and name, "1.2", "m²", a step's minutes "12.5 + 5/4/3 %"), its quantities per size as decimal
 * strings, and the part's totals before → after. A screen hands a section straight to <VersionCompare>; it may relabel
 * the fields by `id` from its own words.
 *
 * Parts (sections, in this order):
 *   revision      the revision's own fields: label template, planned hide yield, output, release scope
 *   bom           lines matched by material, placement and colourway (the n-th such line of one with the n-th of the other,
 *                 in BOM order, as W1's BOM compare); a line whose material changed is one removed and one added. Fields:
 *                 quantity (a size-dependent line: its sizes), unit, wastage, colour, supplier, section, group, sub-assembly,
 *                 customer-supplied, subcontract kit, source, option, step, made-to-measure scaling, alternates, note
 *   routing       steps matched by library operation (n-th, as W1's routing compare). Fields: place, code, name, work
 *                 centre, standard minutes, basic minutes with allowances, the SMV version, set-up / wait / move, scan,
 *                 parallel group, cells (sizes, colourways, options), checkpoint, machine settings, workshop and transit
 *                 days (the workshop's fee is a cost: the cost section), instructions; sizes = the extra minutes per size
 *   measurements  the measurement spec's points matched by point of measure; sizes = the nominal per size; the tolerance
 *   protectors    protector placements matched by pocket (n-th)
 *   pieces        pattern pieces matched by name (unique per revision)
 * The cost (cost grain only) is the API's: it prices both revisions with today's inputs (modules/product/versions).
 */

// ---- what the API reads, codes resolved --------------------------------------------------------------------------------

export interface BomAlternateFacts {
  readonly priority: number
  /** "LIN-210 Airflow mesh". */
  readonly item: string
  readonly itemColour: string | null
  readonly qty: string | null
  readonly allowedWhen: string
  readonly certificateCheck: boolean
}

export interface BomLineFacts {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  /** "LEA-001 Cowhide 1.2 mm". */
  readonly item: string
  readonly placement: string | null
  readonly colourwayId: string | null
  /** The colourway's code (a line for one colourway only). */
  readonly colourway: string | null
  readonly qty: string
  readonly uom: Uom | string
  readonly wastagePct: string
  readonly sizeDependent: boolean
  /** Quantity per size (a size-dependent line). */
  readonly sizes: Readonly<Record<string, string>>
  readonly colourDependent: boolean
  /** The colour per colourway (a colour-dependent line): colourway code → material colour code. */
  readonly colours: readonly { readonly colourway: string; readonly itemColour: string }[]
  readonly itemColour: string | null
  readonly supplier: string | null
  readonly section: string | null
  /** The group row's place (BomLine.parentLineId). */
  readonly parentSeq: number | null
  /** "LNR-01 rev 1". */
  readonly subAssembly: string | null
  readonly customerSupplied: string | null
  readonly issueToSubcontract: boolean
  readonly sourceKey: string | null
  /** "OG-LINER: YES". */
  readonly option: string | null
  readonly routingSeq: number | null
  /** "CHEST_W × 0.5". */
  readonly mtm: string | null
  readonly alternates: readonly BomAlternateFacts[]
  readonly note: string | null
}

export interface StepFacts {
  readonly id: string
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: string
  readonly standardMinutes: string
  readonly basicMinutes: string | null
  readonly personalPct: string | null
  readonly fatiguePct: string | null
  readonly delayPct: string | null
  /** The approved SMV version the step copies (its number). */
  readonly timeVersion: number | null
  readonly setupMinutes: string | null
  readonly waitMinutes: string | null
  readonly moveMinutes: string | null
  readonly scanRequired: boolean
  readonly parallelGroup: number | null
  readonly instructions: string | null
  readonly sizes: readonly string[]
  /** Colourway codes. */
  readonly colourways: readonly string[]
  /** "OG-PERF: FRONT". */
  readonly options: readonly string[]
  /** The checkpoint's inspection plan code. */
  readonly checkpoint: string | null
  /** Extra minutes per size. */
  readonly sizeTimes: Readonly<Record<string, string>>
  /** Each machine setting written on one line, in order. */
  readonly settings: readonly string[]
  readonly workshop: string | null
  readonly transitDays: number | null
}

export interface PieceFacts {
  readonly id: string
  readonly seq: number
  readonly name: string
  readonly quantity: number
  /** "20 · LEA-001". */
  readonly line: string | null
  readonly minGrade: string | null
  readonly grain: string
  readonly sizes: readonly string[]
  readonly note: string | null
}

export interface MeasureFacts {
  readonly nominal: string
  readonly minus: string
  readonly plus: string
}

export interface PointFacts {
  readonly pointId: string
  /** "CHEST_W Chest width". */
  readonly point: string
  readonly uom: string
  readonly seq: number
  /** Per size. */
  readonly values: Readonly<Record<string, MeasureFacts>>
}

export interface MeasurementFacts {
  readonly status: string
  readonly baseSize: string
  readonly gradeRule: string | null
  readonly points: readonly PointFacts[]
}

export interface ProtectorFacts {
  readonly id: string
  readonly seq: number
  readonly pocket: string
  readonly item: string
  readonly standard: string
  readonly level: string
  readonly sizes: readonly string[]
  readonly positionNote: string | null
}

export interface RevisionFacts {
  readonly id: string
  readonly revision: number
  readonly status: string
  /** "LBL-01 r2". */
  readonly labelTemplate: string | null
  readonly plannedHideYieldPct: string | null
  readonly outputQuantity: number
  readonly outputUom: string
  /** Colourway codes released (empty: all). */
  readonly releasedColourways: readonly string[]
  /** Sizes released (empty: all). */
  readonly releasedSizes: readonly string[]
  /** The routing's minutes per garment (W1's routingMinutes, rounded to the minutes' scale). */
  readonly minutesPerGarment: string
}

/** Everything one revision says, as the compare reads it. */
export interface SpecSnapshot {
  readonly revision: RevisionFacts
  readonly bom: readonly BomLineFacts[]
  readonly routing: readonly StepFacts[]
  readonly measurements: MeasurementFacts | null
  readonly protectors: readonly ProtectorFacts[]
  readonly pieces: readonly PieceFacts[]
}

// ---- the answer (VersionCompare's shape) -------------------------------------------------------------------------------

export type Written = string | null

export interface CompareSide {
  readonly fields: Readonly<Record<string, Written>>
  readonly sizes?: Readonly<Record<string, string>>
}

export interface CompareLine {
  /** The same id on both sides: the second revision's row id, or the first's for a removed line. */
  readonly id: string
  readonly label: string
  readonly detail: string | null
  readonly before: CompareSide | null
  readonly after: CompareSide | null
}

export interface CompareField {
  readonly id: string
  readonly label: string
}

export interface CompareTotal {
  readonly id: string
  readonly label: string
  readonly before: Written
  readonly after: Written
}

export interface SectionSummary {
  readonly added: number
  readonly removed: number
  readonly changed: number
  readonly unchanged: number
}

export const SECTION_IDS = ['revision', 'bom', 'routing', 'measurements', 'protectors', 'pieces'] as const
export type SectionId = (typeof SECTION_IDS)[number]

export interface CompareSection {
  readonly id: SectionId
  readonly label: string
  readonly fields: readonly CompareField[]
  /** The sizes in the range's order (a line's quantities per size follow it). */
  readonly sizes: readonly string[]
  readonly lines: readonly CompareLine[]
  readonly totals: readonly CompareTotal[]
  readonly summary: SectionSummary
}

// ---- writing ----------------------------------------------------------------------------------------------------------

const YES = '✓'
const flag = (value: boolean): Written => (value ? YES : null)
const decimal = (value: string | null): Written => (value === null ? null : decimalText(value))
const list = (values: readonly string[]): Written => (values.length === 0 ? null : values.join(', '))
const joined = (parts: readonly (string | null | undefined)[], by = ' · '): string | null => {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0)
  return kept.length === 0 ? null : kept.join(by)
}
const textOf = (value: number | null): Written => (value === null ? null : String(value))

/** Same quantity as exact decimals ("1.2000" is "1.2"); text compared as it is. */
function sameValue(a: Written, b: Written): boolean {
  if (a === null || b === null) return a === b
  if (a === b) return true
  try {
    return decimalOf(a).eq(decimalOf(b))
  } catch {
    return false
  }
}

function lineKind(line: CompareLine, fields: readonly CompareField[], sizes: readonly string[]): 'added' | 'removed' | 'changed' | 'unchanged' {
  if (!line.before) return 'added'
  if (!line.after) return 'removed'
  for (const field of fields) if (!sameValue(line.before.fields[field.id] ?? null, line.after.fields[field.id] ?? null)) return 'changed'
  const sizeIds = sizes.length > 0 ? sizes : [...new Set([...Object.keys(line.before.sizes ?? {}), ...Object.keys(line.after.sizes ?? {})])]
  for (const size of sizeIds) if (!sameValue(line.before.sizes?.[size] ?? null, line.after.sizes?.[size] ?? null)) return 'changed'
  return 'unchanged'
}

function section(id: SectionId, label: string, fields: readonly CompareField[], sizes: readonly string[], lines: readonly CompareLine[], totals: readonly CompareTotal[]): CompareSection {
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  for (const line of lines) summary[lineKind(line, fields, sizes)]++
  return { id, label, fields, sizes, lines, totals, summary }
}

/** Pairs rows of two revisions by a key, the n-th of one with the n-th of the other in their order; then the removed ones. */
function pairBy<T>(before: readonly T[], after: readonly T[], keyOf: (row: T) => string): [T | null, T | null][] {
  const queues = new Map<string, T[]>()
  for (const row of before) queues.set(keyOf(row), [...(queues.get(keyOf(row)) ?? []), row])
  const pairs: [T | null, T | null][] = after.map((row) => [queues.get(keyOf(row))?.shift() ?? null, row])
  for (const rest of queues.values()) for (const row of rest) pairs.push([row, null])
  return pairs
}

const side = (fields: Record<string, Written>, sizes?: Record<string, string>): CompareSide => (sizes ? { fields, sizes } : { fields })

// ---- the revision's own fields -----------------------------------------------------------------------------------------

export const REVISION_FIELDS: readonly CompareField[] = [
  { id: 'labelTemplate', label: 'Garment label' },
  { id: 'plannedHideYieldPct', label: 'Planned hide yield %' },
  { id: 'output', label: 'Makes' },
  { id: 'releasedColourways', label: 'Released colourways' },
  { id: 'releasedSizes', label: 'Released sizes' },
]

function revisionFields(revision: RevisionFacts): Record<string, Written> {
  return {
    labelTemplate: revision.labelTemplate,
    plannedHideYieldPct: decimal(revision.plannedHideYieldPct),
    output: `${revision.outputQuantity} ${revision.outputUom}`,
    releasedColourways: list(revision.releasedColourways),
    releasedSizes: list(revision.releasedSizes),
  }
}

// ---- BOM --------------------------------------------------------------------------------------------------------------

export const BOM_FIELDS: readonly CompareField[] = [
  { id: 'seq', label: 'Line' },
  { id: 'qty', label: 'Quantity' },
  { id: 'uom', label: 'Unit' },
  { id: 'wastagePct', label: 'Wastage %' },
  { id: 'colour', label: 'Colour' },
  { id: 'supplier', label: 'Supplier' },
  { id: 'section', label: 'Section' },
  { id: 'group', label: 'Under line' },
  { id: 'subAssembly', label: 'Sub-assembly' },
  { id: 'customerSupplied', label: 'Supplied by the customer' },
  { id: 'issueToSubcontract', label: 'In the workshop kit' },
  { id: 'sourceKey', label: 'Source' },
  { id: 'option', label: 'Only with option' },
  { id: 'step', label: 'Used at step' },
  { id: 'mtm', label: 'Made-to-measure scaling' },
  { id: 'alternates', label: 'Alternates' },
  { id: 'note', label: 'Note' },
]

const bomKey = (line: BomLineFacts) => `${line.itemId}\u0000${line.placement ?? ''}\u0000${line.colourwayId ?? ''}`

function bomColour(line: BomLineFacts): Written {
  if (line.colourDependent) return line.colours.length === 0 ? null : line.colours.map((cell) => `${cell.colourway}: ${cell.itemColour}`).join(', ')
  return line.itemColour
}

const alternateText = (alternate: BomAlternateFacts): string =>
  joined([`${alternate.priority}. ${alternate.item}`, alternate.itemColour, alternate.qty === null ? null : decimalText(alternate.qty), alternate.allowedWhen, alternate.certificateCheck ? 'CERTIFICATE_CHECK' : null], ' ')!

function bomFields(line: BomLineFacts): Record<string, Written> {
  return {
    seq: String(line.seq),
    // A size-dependent line's quantity follows its sizes: they say what changed.
    qty: line.sizeDependent ? null : decimalText(line.qty),
    uom: line.uom,
    wastagePct: decimalText(line.wastagePct),
    colour: bomColour(line),
    supplier: line.supplier,
    section: line.section,
    group: textOf(line.parentSeq),
    subAssembly: line.subAssembly,
    customerSupplied: line.customerSupplied,
    issueToSubcontract: flag(line.issueToSubcontract),
    sourceKey: line.sourceKey,
    option: line.option,
    step: textOf(line.routingSeq),
    mtm: line.mtm,
    alternates: line.alternates.length === 0 ? null : [...line.alternates].sort((a, b) => a.priority - b.priority).map(alternateText).join('; '),
    note: line.note,
  }
}

const bomSizes = (line: BomLineFacts): Record<string, string> | undefined =>
  line.sizeDependent ? Object.fromEntries(Object.entries(line.sizes).map(([size, qty]) => [size, decimalText(qty)])) : undefined

// ---- routing ----------------------------------------------------------------------------------------------------------

export const ROUTING_FIELDS: readonly CompareField[] = [
  { id: 'seq', label: 'Place' },
  { id: 'code', label: 'Code' },
  { id: 'name', label: 'Name' },
  { id: 'workCentreKind', label: 'Work centre' },
  { id: 'standardMinutes', label: 'Standard minutes' },
  { id: 'allowances', label: 'Basic minutes + allowances' },
  { id: 'timeVersion', label: 'SMV version' },
  { id: 'setupMinutes', label: 'Set-up minutes' },
  { id: 'waitMinutes', label: 'Wait minutes' },
  { id: 'moveMinutes', label: 'Move minutes' },
  { id: 'scanRequired', label: 'Scanned' },
  { id: 'parallelGroup', label: 'Side by side group' },
  { id: 'cells', label: 'Only for' },
  { id: 'checkpoint', label: 'Quality checkpoint' },
  { id: 'settings', label: 'Machine settings' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'transitDays', label: 'Transit days' },
  { id: 'instructions', label: 'Instructions' },
]

/** "12.5 + 5/4/3 %" (basic minutes and the personal, fatigue and delay allowances), or null. */
function allowancesText(step: StepFacts): Written {
  if (step.basicMinutes === null) return null
  const pct = (value: string | null) => (value === null ? '0' : decimalText(value))
  return `${decimalText(step.basicMinutes)} + ${pct(step.personalPct)}/${pct(step.fatiguePct)}/${pct(step.delayPct)} %`
}

function stepFields(step: StepFacts): Record<string, Written> {
  return {
    seq: String(step.seq),
    code: step.code,
    name: step.name,
    workCentreKind: step.workCentreKind,
    standardMinutes: decimalText(step.standardMinutes),
    allowances: allowancesText(step),
    timeVersion: step.timeVersion === null ? null : `v${step.timeVersion}`,
    setupMinutes: decimal(step.setupMinutes),
    waitMinutes: decimal(step.waitMinutes),
    moveMinutes: decimal(step.moveMinutes),
    scanRequired: flag(step.scanRequired),
    parallelGroup: textOf(step.parallelGroup),
    cells: joined([list(step.sizes), list(step.colourways), list(step.options)], ' · '),
    checkpoint: step.checkpoint,
    settings: step.settings.length === 0 ? null : step.settings.join('; '),
    workshop: step.workshop,
    transitDays: textOf(step.transitDays),
    instructions: step.instructions,
  }
}

const stepSizes = (step: StepFacts): Record<string, string> | undefined =>
  Object.keys(step.sizeTimes).length === 0 ? undefined : Object.fromEntries(Object.entries(step.sizeTimes).map(([size, extra]) => [size, decimalText(extra)]))

// ---- measurements, protectors, pieces -------------------------------------------------------------------------------------

export const MEASUREMENT_FIELDS: readonly CompareField[] = [
  { id: 'uom', label: 'Unit' },
  { id: 'tolerance', label: 'Tolerance (− / +)' },
]

/** One tolerance for every size ("0.5 / 1"), or each size's ("50: 0.5 / 1; 52: 0.5 / 1.5") when they differ. */
function toleranceText(point: PointFacts, sizes: readonly string[]): Written {
  const order = [...sizes.filter((size) => point.values[size]), ...Object.keys(point.values).filter((size) => !sizes.includes(size))]
  const per = order.map((size) => ({ size, text: `${decimalText(point.values[size]!.minus)} / ${decimalText(point.values[size]!.plus)}` }))
  if (per.length === 0) return null
  return per.every((entry) => entry.text === per[0]!.text) ? per[0]!.text : per.map((entry) => `${entry.size}: ${entry.text}`).join('; ')
}

export const PROTECTOR_FIELDS: readonly CompareField[] = [
  { id: 'item', label: 'Protector' },
  { id: 'standard', label: 'Standard' },
  { id: 'level', label: 'Level' },
  { id: 'sizes', label: 'Sizes' },
  { id: 'positionNote', label: 'Position' },
]

export const PIECE_FIELDS: readonly CompareField[] = [
  { id: 'seq', label: 'Place' },
  { id: 'quantity', label: 'Per garment' },
  { id: 'line', label: 'BOM line' },
  { id: 'minGrade', label: 'Lowest leather grade' },
  { id: 'grain', label: 'Grain' },
  { id: 'sizes', label: 'Sizes' },
  { id: 'note', label: 'Note' },
]

// ---- the compare ------------------------------------------------------------------------------------------------------

/** The sizes in the range's order, then any other size a revision names. */
function sizesOf(range: readonly string[], ...named: readonly (readonly string[])[]): string[] {
  const extra = [...new Set(named.flat())].filter((size) => !range.includes(size))
  return [...range, ...extra]
}

/**
 * Every part of two revisions of one style compared (`before` the first, `after` the second; either order). `range` is the
 * style's sizes in their order.
 */
export function compareSpecs(before: SpecSnapshot, after: SpecSnapshot, range: readonly string[]): CompareSection[] {
  const sections: CompareSection[] = []

  sections.push(
    section(
      'revision',
      'Revision',
      REVISION_FIELDS,
      [],
      [{ id: after.revision.id, label: 'Revision', detail: null, before: side(revisionFields(before.revision)), after: side(revisionFields(after.revision)) }],
      [],
    ),
  )

  const bomPairs = pairBy([...before.bom].sort((a, b) => a.seq - b.seq), [...after.bom].sort((a, b) => a.seq - b.seq), bomKey)
  const bomLines = bomPairs.map(([from, to]): CompareLine => {
    const line = (to ?? from)!
    return {
      id: line.id,
      label: `${line.seq} · ${line.item}`,
      detail: joined([line.placement, line.section, line.colourway]),
      before: from ? side(bomFields(from), bomSizes(from)) : null,
      after: to ? side(bomFields(to), bomSizes(to)) : null,
    }
  })
  sections.push(
    section('bom', 'BOM', BOM_FIELDS, sizesOf(range, ...[...before.bom, ...after.bom].map((line) => Object.keys(line.sizes))), bomLines, [
      { id: 'lines', label: 'Lines', before: String(before.bom.length), after: String(after.bom.length) },
    ]),
  )

  const stepPairs = pairBy([...before.routing].sort((a, b) => a.seq - b.seq), [...after.routing].sort((a, b) => a.seq - b.seq), (step) => step.operationId)
  const stepLines = stepPairs.map(([from, to]): CompareLine => {
    const step = (to ?? from)!
    return {
      id: step.id,
      label: `${step.seq} · ${step.code} ${step.name}`,
      detail: step.workCentreKind,
      before: from ? side(stepFields(from), stepSizes(from)) : null,
      after: to ? side(stepFields(to), stepSizes(to)) : null,
    }
  })
  sections.push(
    section('routing', 'Routing and minutes', ROUTING_FIELDS, sizesOf(range, ...[...before.routing, ...after.routing].map((step) => Object.keys(step.sizeTimes))), stepLines, [
      { id: 'minutesPerGarment', label: 'Minutes per garment', before: decimalText(before.revision.minutesPerGarment), after: decimalText(after.revision.minutesPerGarment) },
      { id: 'steps', label: 'Steps', before: String(before.routing.length), after: String(after.routing.length) },
    ]),
  )

  const points = (spec: MeasurementFacts | null) => [...(spec?.points ?? [])].sort((a, b) => a.seq - b.seq)
  const pointPairs = pairBy(points(before.measurements), points(after.measurements), (point) => point.pointId)
  const measureSizes = sizesOf(range, ...[...points(before.measurements), ...points(after.measurements)].map((point) => Object.keys(point.values)))
  const nominals = (point: PointFacts) => Object.fromEntries(Object.entries(point.values).map(([size, value]) => [size, decimalText(value.nominal)]))
  const pointSide = (point: PointFacts | null) => (point ? side({ uom: point.uom, tolerance: toleranceText(point, measureSizes) }, nominals(point)) : null)
  const specText = (spec: MeasurementFacts | null): string | null => (spec ? joined([spec.status, `base ${spec.baseSize}`, spec.gradeRule]) : null)
  sections.push(
    section(
      'measurements',
      'Measurement spec',
      MEASUREMENT_FIELDS,
      measureSizes,
      pointPairs.map(([from, to]): CompareLine => {
        const point = (to ?? from)!
        return { id: point.pointId, label: point.point, detail: null, before: pointSide(from), after: pointSide(to) }
      }),
      [
        { id: 'spec', label: 'Spec', before: specText(before.measurements), after: specText(after.measurements) },
        { id: 'points', label: 'Points of measure', before: String(points(before.measurements).length), after: String(points(after.measurements).length) },
      ],
    ),
  )

  const protectorFields = (row: ProtectorFacts): Record<string, Written> => ({ item: row.item, standard: row.standard, level: row.level, sizes: list(row.sizes), positionNote: row.positionNote })
  const protectorPairs = pairBy([...before.protectors].sort((a, b) => a.seq - b.seq), [...after.protectors].sort((a, b) => a.seq - b.seq), (row) => row.pocket)
  sections.push(
    section(
      'protectors',
      'Protector placement',
      PROTECTOR_FIELDS,
      [],
      protectorPairs.map(([from, to]): CompareLine => {
        const row = (to ?? from)!
        return { id: row.id, label: row.pocket, detail: null, before: from ? side(protectorFields(from)) : null, after: to ? side(protectorFields(to)) : null }
      }),
      [],
    ),
  )

  const pieceFields = (piece: PieceFacts): Record<string, Written> => ({
    seq: String(piece.seq),
    quantity: String(piece.quantity),
    line: piece.line,
    minGrade: piece.minGrade,
    grain: piece.grain,
    sizes: list(piece.sizes),
    note: piece.note,
  })
  const piecePairs = pairBy([...before.pieces].sort((a, b) => a.seq - b.seq), [...after.pieces].sort((a, b) => a.seq - b.seq), (piece) => piece.name)
  const perGarment = (pieces: readonly PieceFacts[]) => String(pieces.reduce((total, piece) => total + piece.quantity, 0))
  sections.push(
    section(
      'pieces',
      'Pattern pieces',
      PIECE_FIELDS,
      [],
      piecePairs.map(([from, to]): CompareLine => {
        const piece = (to ?? from)!
        return { id: piece.id, label: piece.name, detail: null, before: from ? side(pieceFields(from)) : null, after: to ? side(pieceFields(to)) : null }
      }),
      [
        { id: 'pieces', label: 'Pieces', before: String(before.pieces.length), after: String(after.pieces.length) },
        { id: 'perGarment', label: 'Pieces per garment', before: perGarment(before.pieces), after: perGarment(after.pieces) },
      ],
    ),
  )

  return sections
}

// ---- in words ---------------------------------------------------------------------------------------------------------

export interface Differs {
  readonly section: SectionId
  readonly label: string
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/** The parts that differ (a section with a line added, removed or changed, or a total that moved). */
export function differsOf(sections: readonly CompareSection[]): Differs[] {
  return sections.flatMap((entry) => {
    const totalsMoved = entry.totals.some((total) => !sameValue(total.before, total.after))
    const { added, removed, changed } = entry.summary
    return added + removed + changed > 0 || totalsMoved ? [{ section: entry.id, label: entry.label, added, removed, changed }] : []
  })
}

/** "BOM: 1 added, 2 changed · Routing and minutes: 1 changed", or "the same spec". */
export function differsWords(differs: readonly Differs[]): string {
  if (differs.length === 0) return 'the same spec'
  return differs
    .map((entry) => {
      const parts = [entry.added ? `${entry.added} added` : null, entry.removed ? `${entry.removed} removed` : null, entry.changed ? `${entry.changed} changed` : null].filter(Boolean)
      return `${entry.label}: ${parts.length > 0 ? parts.join(', ') : 'totals changed'}`
    })
    .join(' · ')
}

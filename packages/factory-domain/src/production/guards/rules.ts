import type { ItemTracking } from '../../product/materials/rules'
import type { GarmentTracking } from '../serials/rules'
import {
  countsTotal,
  nextScanned,
  operationLabel,
  scannedOperations,
  sewnOperationOf,
  standingKey,
  totalOf,
  type Counts,
  type ScanFact,
  type ScanOperation,
  type ScanRefusal,
  type ScanRefusalCode,
} from '../scans/rules'

/**
 * Checks before a scan counts (B-W2b-46; MES-070, MES-097, MES-098, MES-114; design floor.operation "Checks before it
 * counts", "Scan what you used" and the pop-up "Team leader override"; EN 1621-1/-2 protectors traced per garment), pure.
 * The API (apps/factory-api modules/production/guards, hooked into the scans' report through scans/hooks/guards.ts) reads
 * the facts inside the report's command, under the scans' locks, and writes the record of what it found.
 *
 *   quantity    MES-097: more garments at an operation than the operation before it passed (its standing report's good;
 *               the bundle's garments at the first), or, when a skipped operation is reported late, fewer good than the
 *               operation after it already took. The site's rule (ProductionSettings.quantityGuard): STRICT (the default)
 *               holds the scan for a team leader's override, WARN lets it count and tells the team leader, FREE lets it
 *               count. More than the bundle's own garments is never taken (MORE_THAN_BUNDLE; the database caps it too).
 *   skipped     MES-098: a required (scanned) operation before this one has no standing report for the bundle. The site's
 *               rule (skippedOperationRule): WARN (the default) lets it count and tells the team leader; STRICT holds it
 *               (W1's refusal, not final: the earlier scan may still be in another tablet's queue); FREE lets it count.
 *               The garments the earlier operations passed are then the last reported one's (or the bundle's).
 *   wrong       MES-070: the bundle's work order is allocated to another line than the station's (WorkOrder.lineId, the
 *               allocation board), and that line has a station of the operation's kind: held for a team leader's
 *               override (no site rule: always STRICT). "Not at this station" (another kind of work), "not next"
 *               (skipped) and "on hold" are W1's OTHER_KIND / NO_OPERATION_HERE, the skipped check above and W2a's
 *               ON_HOLD.
 *   override    a team leader signs on the tablet with their PIN and a reason tile: never on their own scan, only with
 *               the floor right production.scan.override. It lifts the held checks of that one report; the record keeps
 *               what was overridden, by whom and why (one record; never a list of people).
 *   components  MES-114: where a garment is traced per garment (the style's garmentTracking SERIAL), the sewn operation
 *               (the last scanned SEWING or ASSEMBLY one) asks the lots of the cell's PPE components traced by lot (EN
 *               1621 protectors): every garment that goes on from it (good and rework) carries one lot of each. Any
 *               operation may record lots of the cell's lot-traced materials. A wrong item, an unknown lot, a lot not
 *               released or a count that does not cover the garments is refused; no override (PPE traceability).
 * Every finding and refusal is in words with ONE fix; none names a person (Statuto dei Lavoratori art. 4).
 */

export const FLOOR_RULE_MODES = ['FREE', 'WARN', 'STRICT'] as const
export type FloorRuleMode = (typeof FLOOR_RULE_MODES)[number]

/** A site's floor checks (ProductionSettings.quantityGuard / skippedOperationRule; B-W2b-12). */
export interface GuardSettings {
  readonly quantityGuard: FloorRuleMode
  readonly skippedOperationRule: FloorRuleMode
}

/** The schema's defaults, also for a site without floor rules. */
export const DEFAULT_GUARD_SETTINGS: GuardSettings = Object.freeze({ quantityGuard: 'STRICT', skippedOperationRule: 'WARN' })

export function guardSettingsOf(row: { readonly quantityGuard: string; readonly skippedOperationRule: string } | null | undefined): GuardSettings {
  if (!row) return DEFAULT_GUARD_SETTINGS
  const mode = (value: string, fallback: FloorRuleMode): FloorRuleMode => ((FLOOR_RULE_MODES as readonly string[]).includes(value) ? (value as FloorRuleMode) : fallback)
  return { quantityGuard: mode(row.quantityGuard, DEFAULT_GUARD_SETTINGS.quantityGuard), skippedOperationRule: mode(row.skippedOperationRule, DEFAULT_GUARD_SETTINGS.skippedOperationRule) }
}

export const GUARD_KINDS = ['QUANTITY', 'SKIPPED_OPERATION', 'WRONG_BUNDLE'] as const
export type GuardKind = (typeof GUARD_KINDS)[number]

/** The refusal codes this module adds to the scans' list (production/scans/rules SCAN_REFUSALS, its B-W2b-46 block). */
export const GUARD_REFUSALS = [
  'WRONG_BUNDLE',
  'COMPONENTS_MISSING',
  'WRONG_COMPONENT',
  'UNKNOWN_LOT',
  'LOT_NOT_RELEASED',
  'COMPONENT_COUNT',
  'OVERRIDE_PIN_WRONG',
  'OVERRIDE_NOT_LEAD',
  'OVERRIDE_SELF',
  'OVERRIDE_NOTE_MISSING',
] as const satisfies readonly ScanRefusalCode[]

/**
 * The refusals of a report a team leader may override on the tablet (the floor's operation screen offers "Team leader
 * override" for these, B-W2b-69): the held checks. W1's codes keep W1's words; WRONG_BUNDLE is new.
 */
export const OVERRIDABLE_REFUSALS = ['PREVIOUS_NOT_REPORTED', 'MORE_THAN_PASSED', 'LESS_THAN_TAKEN', 'WRONG_BUNDLE'] as const satisfies readonly ScanRefusalCode[]

const refusal = (code: ScanRefusalCode, message: string, fix: string, final = true): ScanRefusal => ({ code, message, fix, final })
const garments = (count: number) => `${count} garment${count === 1 ? '' : 's'}`
const OVERRIDE_FIX = 'ask your team leader to override it with their PIN and a reason'
/** W1's fix of a held check, and the override (only where the check holds: STRICT). */
const withOverride = (fix: string, mode: 'WARN' | 'STRICT'): string => (mode === 'STRICT' ? `${fix} A team leader may override it with their PIN and a reason.` : fix)

// ---- what the earlier operations passed -----------------------------------------------------------------------------------------

export interface PassedTo {
  /** The scanned operation right before this one, or null at the first. */
  readonly previous: ScanOperation | null
  /** The nearest earlier scanned operation with a standing report (whose good the bundle carries), or null. */
  readonly from: ScanOperation | null
  /** The garments that reached this operation: `from`'s standing good, or the bundle's garments. */
  readonly passed: number
  /** The scanned operations between `from` and this one with no standing report, in routing order. */
  readonly skipped: readonly ScanOperation[]
}

/** What reached the operation for the bundle, walking back through the scanned operations to the last reported one. */
export function passedTo(operations: readonly ScanOperation[], operation: Pick<ScanOperation, 'seq'>, bundleQuantity: number, standing: ReadonlyMap<string, ScanFact>, bundleId: string): PassedTo {
  const earlier = scannedOperations(operations).filter((candidate) => candidate.seq < operation.seq)
  const skipped: ScanOperation[] = []
  for (const candidate of [...earlier].reverse()) {
    const scan = standing.get(standingKey(bundleId, candidate.id))
    if (scan) return { previous: earlier.at(-1) ?? null, from: candidate, passed: scan.goodQuantity, skipped: skipped.reverse() }
    skipped.push(candidate)
  }
  return { previous: earlier.at(-1) ?? null, from: null, passed: bundleQuantity, skipped: skipped.reverse() }
}

// ---- the findings ------------------------------------------------------------------------------------------------------------------

export interface GuardLine {
  readonly id: string
  readonly code: string
}

export interface GuardFacts {
  readonly operations: readonly ScanOperation[]
  /** The operation the report is for (W1's reportDecision chose it). */
  readonly operation: ScanOperation
  readonly bundleId: string
  /** The bundle's code and its live garments (bundles/flow: a split parent counts at most its live garments). */
  readonly bundle: { readonly code: string; readonly quantity: number }
  readonly workOrder: { readonly number: string }
  /** The bundle's standing scans as the flow reads them (rework back in it, a child in its parent's place). */
  readonly standing: ReadonlyMap<string, ScanFact>
  readonly counts: Counts
  readonly settings: GuardSettings
  /** The station's line and the work order's (allocated) line, when known; `lineHasKind`: the work order's line has an active station of the operation's kind. */
  readonly lines: { readonly station: { readonly code: string; readonly line: GuardLine | null } | null; readonly workOrder: GuardLine | null; readonly lineHasKind: boolean }
}

export interface GuardFinding {
  readonly kind: GuardKind
  /** STRICT holds the scan for a team leader's override; WARN lets it count and tells the team leader. */
  readonly mode: 'WARN' | 'STRICT'
  readonly refusal: ScanRefusal
  /** The facts for the record: operations by id, garments; never a person. */
  readonly detail: Readonly<Record<string, string | number | readonly string[] | null>>
}

export interface GuardResult {
  readonly passed: PassedTo
  /** What the report may count before the quantity rule: the garments that reached the operation. */
  readonly cap: number
  readonly findings: readonly GuardFinding[]
}

const counted = (mode: FloorRuleMode): mode is 'WARN' | 'STRICT' => mode !== 'FREE'

/** The checks of one report at its operation (after W1's operation, kind, already-reported and bundle-size checks). */
export function guardFindings(facts: GuardFacts): GuardResult {
  const passed = passedTo(facts.operations, facts.operation, facts.bundle.quantity, facts.standing, facts.bundleId)
  const total = countsTotal(facts.counts)
  const findings: GuardFinding[] = []
  const { quantityGuard, skippedOperationRule } = facts.settings

  const { station, workOrder: woLine } = facts.lines
  if (station?.line && woLine && station.line.id !== woLine.id && facts.lines.lineHasKind) {
    findings.push({
      kind: 'WRONG_BUNDLE',
      mode: 'STRICT',
      refusal: refusal('WRONG_BUNDLE', `Bundle ${facts.bundle.code} is for line ${woLine.code} (work order ${facts.workOrder.number}); ${station.code} is on line ${station.line.code}.`, `Take it to line ${woLine.code}, or ${OVERRIDE_FIX}.`),
      detail: { bundleLineId: woLine.id, stationLineId: station.line.id },
    })
  }

  if (passed.skipped.length > 0 && counted(skippedOperationRule)) {
    const [first] = passed.skipped
    const last = passed.skipped.at(-1)!
    // One skipped operation: W1's words (PREVIOUS_NOT_REPORTED); several: all of them.
    const message =
      passed.skipped.length === 1
        ? `${operationLabel(last)} has not passed bundle ${facts.bundle.code} yet.`
        : `${passed.skipped.map(operationLabel).join(', ')} have not passed bundle ${facts.bundle.code} yet.`
    findings.push({
      kind: 'SKIPPED_OPERATION',
      mode: skippedOperationRule,
      refusal: refusal('PREVIOUS_NOT_REPORTED', message, withOverride(`Report it at Op ${first!.seq} first; if it waits in another tablet's queue, this one is sent again by itself.`, skippedOperationRule), false),
      detail: { skippedOperationIds: passed.skipped.map((operation) => operation.id), fromOperationId: passed.from?.id ?? null },
    })
  }

  if (passed.from && total > passed.passed && counted(quantityGuard)) {
    findings.push({
      kind: 'QUANTITY',
      mode: quantityGuard,
      // W1's words (MORE_THAN_PASSED): the operation that passed them and the count.
      refusal: refusal('MORE_THAN_PASSED', `${operationLabel(passed.from)} passed ${garments(passed.passed)} of bundle ${facts.bundle.code}; ${total} reported here.`, withOverride(`Count again: at most ${passed.passed}, or ask a correction of Op ${passed.from.seq} first.`, quantityGuard)),
      detail: { fromOperationId: passed.from.id, passed: passed.passed, reported: total },
    })
  }

  const next = nextScanned(facts.operations, facts.operation.id)
  const taken = next ? facts.standing.get(standingKey(facts.bundleId, next.id)) : undefined
  if (next && taken && facts.counts.good < totalOf(taken) && counted(quantityGuard)) {
    const took = totalOf(taken)
    findings.push({
      kind: 'QUANTITY',
      mode: quantityGuard,
      refusal: refusal('LESS_THAN_TAKEN', `${operationLabel(next)} took ${garments(took)} of bundle ${facts.bundle.code} already; ${facts.counts.good} good here is fewer.`, `Count again (at least ${took} good), or ${OVERRIDE_FIX}.`),
      detail: { nextOperationId: next.id, taken: took, good: facts.counts.good },
    })
  }

  return { passed, cap: passed.passed, findings }
}

/** The order in which held checks are named (the refusal's code is the first one's). */
const HOLD_ORDER: readonly ScanRefusalCode[] = ['WRONG_BUNDLE', 'PREVIOUS_NOT_REPORTED', 'MORE_THAN_PASSED', 'LESS_THAN_TAKEN']

/**
 * The refusal that holds the report, or null: the STRICT findings. One: its own words (W1's for W1's codes). Several:
 * every one's words and the override as the fix; final unless every one may pass by itself.
 */
export function heldBy(findings: readonly GuardFinding[]): ScanRefusal | null {
  const strict = findings.filter((finding) => finding.mode === 'STRICT').sort((a, b) => HOLD_ORDER.indexOf(a.refusal.code) - HOLD_ORDER.indexOf(b.refusal.code))
  if (strict.length === 0) return null
  if (strict.length === 1) return strict[0]!.refusal
  return refusal(
    strict[0]!.refusal.code,
    strict.map((finding) => finding.refusal.message).join(' '),
    `Ask your team leader to override them with their PIN and a reason, or fix each first.`,
    strict.some((finding) => finding.refusal.final),
  )
}

/** The findings a report records: WARN ones always; STRICT ones only when a team leader overrode them. */
export const kindsOf = (findings: readonly GuardFinding[]): GuardKind[] => [...new Set(findings.map((finding) => finding.kind))].sort()

// ---- the team leader's override ------------------------------------------------------------------------------------------------------

export const OVERRIDE_REASON_CODES = ['COUNTED_AGAIN', 'EARLIER_LATE', 'COVERING_LINE', 'BACK_FROM_REWORK', 'OTHER'] as const
export type OverrideReasonCode = (typeof OVERRIDE_REASON_CODES)[number]

export interface OverrideReason {
  readonly code: OverrideReasonCode
  readonly label: { readonly it: string; readonly en: string }
  /** The team leader writes why (a few words) with this tile. */
  readonly needsNote: boolean
}

/**
 * The reason tiles of an override (design operation.override: "a reason tile, then the team leader's PinPad"). A fixed
 * list: the reason lists (reasons.prisma ReasonList) have no OVERRIDE list yet (a schema need, named in the step notes).
 */
export const OVERRIDE_REASONS: readonly OverrideReason[] = Object.freeze([
  { code: 'COUNTED_AGAIN', label: { it: 'Ricontati: i pezzi ci sono', en: 'Counted again: the pieces are here' }, needsNote: false },
  { code: 'EARLIER_LATE', label: { it: "L'operazione prima si registra dopo", en: 'The earlier operation is recorded later' }, needsNote: false },
  { code: 'COVERING_LINE', label: { it: "Aiuto un'altra linea", en: 'Helping another line' }, needsNote: false },
  { code: 'BACK_FROM_REWORK', label: { it: 'Pezzi tornati dalla ripresa', en: 'Pieces back from rework' }, needsNote: false },
  { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
])
/** The words of an override's reason for the record: the tile's English words, and the note when there is one. */
export function overrideReasonText(code: OverrideReasonCode, note: string | null): string {
  const tile = OVERRIDE_REASONS.find((reason) => reason.code === code)!
  return note ? `${tile.label.en}: ${note}` : tile.label.en
}

export const overridePinWrong = (): ScanRefusal =>
  refusal('OVERRIDE_PIN_WRONG', "The team leader's badge or PIN is wrong, or they are locked for a few minutes after too many wrong PINs.", 'The team leader tries again, or another team leader signs.', false)

/** Why a team leader's override is refused (the PIN is checked first, by the API), or null. */
export function overrideRefusal(facts: { readonly leadId: string; readonly operatorId: string; readonly mayOverride: boolean; readonly reasonCode: OverrideReasonCode; readonly note: string | null }): ScanRefusal | null {
  if (facts.leadId === facts.operatorId) return refusal('OVERRIDE_SELF', 'A team leader never overrides a check of their own scan (four eyes).', 'Ask another team leader to sign.')
  if (!facts.mayOverride) return refusal('OVERRIDE_NOT_LEAD', 'This person may not override floor checks.', 'Ask a team leader of this site to sign.')
  const tile = OVERRIDE_REASONS.find((reason) => reason.code === facts.reasonCode)
  if (tile?.needsNote && !facts.note) return refusal('OVERRIDE_NOTE_MISSING', 'With "Other" the team leader says why in a few words.', 'Write why, then sign again.')
  return null
}

// ---- components and lots at the operation ----------------------------------------------------------------------------------------------

/** A planned material of the bundle's cell (WorkOrderMaterial → Item). */
export interface ComponentMaterial {
  readonly itemId: string
  readonly code: string
  readonly name: string
  readonly tracking: ItemTracking
  /** A component that is part of the protection (Item.isPpeComponent, or an EN 1621 protector by kind). */
  readonly ppe: boolean
}

/** A lot the operator scanned for some of the garments, as the database has it (null: no lot of that code at the site). */
export interface ScannedLot {
  readonly code: string
  readonly garments: number
  readonly lot: { readonly id: string; readonly code: string; readonly itemId: string; readonly qualityStatus: string } | null
}

export interface TracedComponent {
  readonly itemId: string
  readonly itemCode: string
  readonly lotId: string
  readonly lotCode: string
  readonly garments: number
}

/** The components the operation asks to scan: the cell's PPE components traced by lot, at the sewn operation of a style traced per garment. */
export function componentsAsked(facts: { readonly operations: readonly ScanOperation[]; readonly operation: Pick<ScanOperation, 'id'>; readonly garmentTracking: GarmentTracking; readonly materials: readonly ComponentMaterial[] }): ComponentMaterial[] {
  if (facts.garmentTracking !== 'SERIAL' || sewnOperationOf(facts.operations)?.id !== facts.operation.id) return []
  return facts.materials.filter((material) => material.ppe && material.tracking === 'LOT').sort((a, b) => a.code.localeCompare(b.code))
}

/** The garments that go on from a report (they carry the components on): good and rework. */
export const garmentsGoingOn = (counts: Counts): number => counts.good + counts.rework

/** Whether the scanned lots trace the garments that go on from the operation; the traced lines, or the refusal. */
export function componentDecision(facts: {
  readonly asked: readonly ComponentMaterial[]
  readonly materials: readonly ComponentMaterial[]
  readonly scanned: readonly ScannedLot[]
  readonly garments: number
  readonly operation: Pick<ScanOperation, 'seq' | 'name'>
}): { readonly ok: true; readonly lines: TracedComponent[] } | { readonly ok: false; readonly refusal: ScanRefusal } {
  const merged = new Map<string, ScannedLot>()
  for (const entry of facts.scanned) {
    const key = entry.code.trim().toUpperCase()
    merged.set(key, { ...entry, code: key, garments: (merged.get(key)?.garments ?? 0) + entry.garments })
  }
  const lines: TracedComponent[] = []
  for (const entry of merged.values()) {
    if (!entry.lot) return { ok: false, refusal: refusal('UNKNOWN_LOT', `${entry.code} is not a lot of this site.`, "Scan the lot's label again, or ask your team leader.") }
    const material = facts.materials.find((candidate) => candidate.itemId === entry.lot!.itemId && candidate.tracking === 'LOT')
    if (!material) return { ok: false, refusal: refusal('WRONG_COMPONENT', `Lot ${entry.lot.code} is not a material of this garment traced by lot.`, 'Take it away and scan the lot of the component in your hand.') }
    if (entry.lot.qualityStatus !== 'RELEASED') {
      const state = entry.lot.qualityStatus === 'QUARANTINE' ? 'in quarantine' : entry.lot.qualityStatus.toLowerCase()
      return { ok: false, refusal: refusal('LOT_NOT_RELEASED', `Lot ${entry.lot.code} is ${state}: only a released lot goes into a garment.`, 'Use a released lot, or ask quality to release this one; the queue sends it again.', false) }
    }
    lines.push({ itemId: material.itemId, itemCode: material.code, lotId: entry.lot.id, lotCode: entry.lot.code, garments: entry.garments })
  }
  const itemIds = [...new Set([...facts.asked.map((material) => material.itemId), ...lines.map((line) => line.itemId)])]
  for (const itemId of itemIds) {
    const material = facts.materials.find((candidate) => candidate.itemId === itemId)!
    const covered = lines.filter((line) => line.itemId === itemId).reduce((sum, line) => sum + line.garments, 0)
    if (covered === 0 && facts.garments > 0) {
      return { ok: false, refusal: refusal('COMPONENTS_MISSING', `Op ${facts.operation.seq} ${facts.operation.name} traces ${material.code} ${material.name} per garment: no lot of it is scanned.`, `Scan the lot of ${material.code} for the ${garments(facts.garments)}.`) }
    }
    if (covered !== facts.garments) {
      return {
        ok: false,
        refusal: refusal(
          'COMPONENT_COUNT',
          facts.garments === 0 ? `No garment goes on from Op ${facts.operation.seq}: no lot of ${material.code} is traced.` : `The lots of ${material.code} cover ${garments(covered)}; ${garments(facts.garments)} go on from Op ${facts.operation.seq}.`,
          facts.garments === 0 ? 'Remove the lots.' : `Give each lot its garments, ${facts.garments} together.`,
        ),
      }
    }
  }
  lines.sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.lotCode.localeCompare(b.lotCode))
  return { ok: true, lines }
}

/**
 * SCR-175 — Incoming inspection on the floor (design floor.incoming; QHS-025, QHS-028, QHS-032 … QHS-034, QHS-036, QHS-065,
 * MES-054; B-W2b-115 on the API of B-W2b-98 and B-W2b-111): the rules of the screen without React or the network, so the tests
 * hold them. The decisions, mark kinds, next steps and component kinds are factory-domain's (quality/incoming: a test holds these
 * copies to it). The API decides every rule again; the screen holds a button with the reason in its own words first.
 *
 *   sample      "Inspect 5 of 12 hides · 2 done" from the numbers (hides, rolls, units, a workshop's pieces)
 *   sections    Hides (a lot counted by hide), Rolls (a lot counted in a length: 4-point), Components and the defect counter (any
 *               other lot and goods back from a workshop), Checks (the plan's), Decision — each with its state as a word
 *   a hide      shade tile, grade, the area measured against the tannery's, defect marks and grade zones on the HideMap, Accept or
 *               Reject: ONE write (online first, kept on the tablet when the network fails)
 *   a roll      the 1- to 4-point counters, width and length, points per 100 square yards against the limit (40): accept or reject
 *   a component kind, type A or B and the EN 1621 certificate for a protector, pieces looked at and not right: accept or reject
 *   decision    accepted + rejected + to sort = the lot; the sample binds them; a workshop's bundles decide its pieces; signed with
 *               the PIN (online only). An override of the rules' result is the office's (it needs written words).
 * Never a person, never money.
 */

import type { BenchPayload, HideResult, IncomingRecord } from './api'

export const UNIT_DECISIONS = ['ACCEPTED', 'REJECTED', 'TO_SORT'] as const
export type UnitDecision = (typeof UNIT_DECISIONS)[number]
export const MARK_KINDS = ['DEFECT', 'ZONE'] as const
export type MarkKind = (typeof MARK_KINDS)[number]
export const NEXT_STEPS = ['RELEASE', 'REJECT', 'SORT', 'RELEASE_PART'] as const
export type NextStep = (typeof NEXT_STEPS)[number]
export const COMPONENT_KINDS = ['PROTECTOR', 'ZIP', 'REFLECTIVE', 'HARDWARE', 'OTHER'] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]
export const PROTECTOR_TYPES = ['A', 'B'] as const
export type ProtectorType = (typeof PROTECTOR_TYPES)[number]
/** The points per 100 square yards a roll is accepted under (factory-domain FOUR_POINT_LIMIT). */
export const FOUR_POINT_LIMIT = 40
/** At most this many marks on one hide (factory-domain INCOMING_LIMITS.marks); a zone's outline at most this many points. */
export const MARK_LIMIT = 60
export const OUTLINE_LIMIT = 60

/** The refusal codes the screen has its own words for (B-W2b-106's scan, the floor's readiness); the rest are said by kind. */
export const KNOWN_REFUSALS = ['OTHER_BENCH', 'NOTHING_TO_INSPECT', 'CHOOSE', 'LABEL', 'FLOOR_NOT_READY'] as const
const KNOWN = new Set<string>(KNOWN_REFUSALS)
export const isKnownRefusal = (code: string): boolean => KNOWN.has(code)

// ---- the record as the rules read it -----------------------------------------------------------------------------------------

export interface MarkFacts {
  readonly kind: MarkKind
  readonly x: number
  readonly y: number
  readonly code?: string | null
  readonly zone?: string | null
  readonly outline?: readonly { readonly x: number; readonly y: number }[] | null
}

export interface HideFacts {
  readonly id: string
  readonly hideId: string
  readonly code: string
  readonly seq: number
  readonly state: string
  readonly receivedArea: { readonly area: string; readonly uom: string }
  readonly measured: boolean
  readonly declaredArea: string | null
  readonly measuredArea: string
  readonly areaUom: string
  readonly areaCheck: { readonly declared: string; readonly difference: string; readonly differencePercent: string; readonly outcome: 'WITHIN' | 'SHORT' | 'OVER' } | null
  readonly shadeGroup: { readonly id: string; readonly label: string; readonly outOfShade: boolean } | null
  readonly grade: { readonly id: string; readonly code: string } | null
  readonly marks: readonly (MarkFacts & { readonly defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR' | null; readonly labelIt: string | null; readonly labelEn: string | null; readonly note: string | null; readonly code: string | null; readonly zone: string | null; readonly outline: readonly { readonly x: number; readonly y: number }[] })[]
  readonly worstClass: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  readonly decision: UnitDecision | null
  readonly note: string | null
  readonly version: number
}

export interface RecordFacts {
  readonly inspection: {
    readonly id: string
    readonly number: string
    readonly status: 'OPEN' | 'DECIDED' | 'CANCELLED'
    readonly subject: 'LOT' | 'WORKSHOP'
    readonly lotSize: string
    readonly uom: string
    readonly byHide: boolean
    readonly byRoll: boolean
    readonly sampleSize: number
    readonly acceptMajor: number | null
    readonly acceptMinor: number | null
    readonly found: { readonly critical: number; readonly major: number; readonly minor: number }
    readonly version: number
  }
  readonly progress: { readonly done: number; readonly sampleSize: number; readonly decided: number; readonly accepted: number; readonly rejected: number; readonly toSort: number; readonly undecided: number }
  readonly result: { readonly resultNow: 'PASS' | 'FAIL'; readonly classes: readonly { readonly defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR'; readonly accept: number; readonly found: number; readonly state: 'ok' | 'limit' | 'reject' }[] }
  readonly hides: readonly HideFacts[]
  readonly rolls: readonly { readonly id: string; readonly rollRef: string; readonly roll: { readonly id: string; readonly code: string } | null; readonly lengthM: string; readonly decision: UnitDecision | null }[]
  readonly components: readonly { readonly seq: number; readonly decision: UnitDecision | null }[]
  readonly checks: readonly CheckFacts[]
  readonly receipt: { readonly lines: readonly ReceiptLineFacts[] } | null
  readonly candidates: readonly { readonly hideId: string; readonly code: string; readonly state: string; readonly whole: boolean; readonly area: string; readonly areaUom: string }[]
  readonly may: { readonly record: boolean; readonly decide: boolean }
}

export interface CheckFacts {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly type: string
  readonly checkClass: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  readonly mandatory: boolean
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly uom: string | null
  readonly choices: readonly string[]
  readonly answers: readonly { readonly id: string; readonly sampleIndex: number; readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; readonly value: string | null; readonly note: string | null }[]
}

export interface ReceiptLineFacts {
  readonly id: string
  readonly seq: number
  readonly operation: { readonly seq: number; readonly code: string; readonly name: string }
  readonly bundle: { readonly id: string; readonly code: string } | null
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly state: 'REPORTED' | 'HELD' | 'REJECTED' | 'NOT_REPORTED'
}

// ---- numbers ------------------------------------------------------------------------------------------------------------------

/** A quantity as the API takes it: a dot, at most four decimals, no trailing zeros. */
export function quantityText(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000
  return String(rounded)
}

/** A decimal from the API ("12.0000") as a number. */
export const numberOf = (text: string | null | undefined): number => (text === null || text === undefined || text.trim() === '' ? 0 : Number(text))

/** The lot is counted in whole units (hides, pieces): its quantities are whole numbers. */
export const wholeUnits = (uom: string): boolean => !['M', 'CM', 'MM', 'KG', 'G', 'M2', 'DM2', 'FT2', 'L'].includes(uom)

// ---- the sample (design floor.incoming sec:sample "Inspect 13 of 120 hides") ------------------------------------------------------

export type SampleKind = 'hides' | 'rolls' | 'units' | 'workshop'

export interface Sample {
  readonly kind: SampleKind
  readonly sample: number
  readonly lot: number
  readonly uom: string
  /** The whole lot is the sample. */
  readonly all: boolean
  /** Units done so far, where the record counts them (hides, rolls); null for a counted lot. */
  readonly done: number | null
}

export function sampleOf(record: Pick<RecordFacts, 'inspection' | 'progress' | 'rolls'>): Sample {
  const { inspection } = record
  const lot = numberOf(inspection.lotSize)
  const kind: SampleKind = inspection.subject === 'WORKSHOP' ? 'workshop' : inspection.byHide ? 'hides' : inspection.byRoll ? 'rolls' : 'units'
  const done = kind === 'hides' ? record.progress.done : kind === 'rolls' ? record.rolls.length : null
  return { kind, sample: inspection.sampleSize, lot, uom: inspection.uom, all: kind !== 'rolls' && lot === inspection.sampleSize, done }
}

/** The sample's progress in percent (null: a counted lot shows no bar). */
export const sampleProgress = (sample: Sample): number | null => (sample.done === null || sample.sample <= 0 ? null : Math.min(100, Math.round((sample.done / sample.sample) * 100)))

// ---- sections ----------------------------------------------------------------------------------------------------------------

export const SECTIONS = ['hides', 'rolls', 'components', 'counter', 'checks', 'decision'] as const
export type Section = (typeof SECTIONS)[number]

/** The sections of this inspection, in the design's order (a lot by hide: hides; in a length: rolls; else components and the counter). */
export function sectionsOf(record: Pick<RecordFacts, 'inspection' | 'components' | 'checks'>): Section[] {
  const { byHide, byRoll } = record.inspection
  const out: Section[] = []
  if (byHide) out.push('hides')
  if (byRoll) out.push('rolls')
  if ((!byHide && !byRoll) || record.components.length > 0) out.push('components')
  if (!byHide && !byRoll) out.push('counter')
  if (record.checks.length > 0) out.push('checks')
  out.push('decision')
  return out
}

/** The first section that has work left (the screen opens there), else the decision. */
export function firstSection(record: RecordFacts): Section {
  const sections = sectionsOf(record)
  return sections.find((section) => section !== 'decision' && sectionState(record, section).state !== 'done') ?? 'decision'
}

export type SectionTone = 'todo' | 'partly' | 'done' | 'failed'

export interface SectionState {
  readonly state: SectionTone
  /** How far: done of the sample, answered of the checks; null: no count. */
  readonly done: number | null
  readonly of: number | null
}

/** Where a section stands, as a word and an icon on its button (never colour alone). */
export function sectionState(record: RecordFacts, section: Section): SectionState {
  const sample = record.inspection.sampleSize
  switch (section) {
    case 'hides': {
      const done = record.hides.length
      const undecided = record.hides.filter((hide) => hide.decision === null).length
      const rejected = record.hides.some((hide) => hide.decision === 'REJECTED')
      return { state: done === 0 ? 'todo' : done < sample || undecided > 0 ? 'partly' : rejected ? 'failed' : 'done', done, of: sample }
    }
    case 'rolls': {
      const done = record.rolls.length
      const undecided = record.rolls.filter((roll) => roll.decision === null).length
      const rejected = record.rolls.some((roll) => roll.decision === 'REJECTED')
      return { state: done === 0 ? 'todo' : done < sample || undecided > 0 ? 'partly' : rejected ? 'failed' : 'done', done, of: sample }
    }
    case 'components': {
      const done = record.components.length
      const undecided = record.components.filter((line) => line.decision === null).length
      const rejected = record.components.some((line) => line.decision === 'REJECTED')
      return { state: done === 0 ? 'todo' : undecided > 0 ? 'partly' : rejected ? 'failed' : 'done', done, of: null }
    }
    case 'counter': {
      const found = record.inspection.found
      const any = found.critical + found.major + found.minor
      return { state: record.result.resultNow === 'FAIL' && any > 0 ? 'failed' : 'done', done: any, of: null }
    }
    case 'checks': {
      const answerable = record.checks.filter((check) => check.type !== 'INSTRUCTION' && check.type !== 'FREE_TEXT')
      const answered = answerable.filter((check) => answerOf(check) !== null).length
      const failed = answerable.some((check) => answerOf(check)?.outcome === 'FAIL')
      const left = checksLeft(record.checks).length
      return { state: answered === 0 && answerable.length > 0 ? 'todo' : left > 0 ? 'partly' : failed ? 'failed' : 'done', done: answered, of: answerable.length }
    }
    case 'decision':
      return { state: 'todo', done: null, of: null }
  }
}

// ---- hide by hide (QHS-025, QHS-028, MES-054) ---------------------------------------------------------------------------------

export interface HideDraft {
  readonly hideId: string
  readonly code: string
  readonly shadeGroupId: string | null
  readonly gradeId: string | null
  /** The area measured now; null: not measured again (the area received stands). */
  readonly measuredArea: number | null
  readonly areaUom: string
  /** The area the tannery declared for this hide (received), against which the measure is checked. */
  readonly declaredArea: number
  readonly marks: readonly MarkFacts[]
}

/** A hide of the sample, or a candidate of the lot not in it yet, as the bench edits it. Null: not a hide of this lot. */
export function hideDraftOf(record: Pick<RecordFacts, 'hides' | 'candidates'>, hideId: string): HideDraft | null {
  const result = record.hides.find((hide) => hide.hideId === hideId)
  if (result) {
    return {
      hideId,
      code: result.code,
      shadeGroupId: result.shadeGroup?.id ?? null,
      gradeId: result.grade?.id ?? null,
      measuredArea: result.measured ? numberOf(result.measuredArea) : null,
      areaUom: result.areaUom,
      declaredArea: numberOf(result.areaCheck?.declared ?? result.declaredArea ?? result.receivedArea.area),
      marks: result.marks.map((mark) => ({ kind: mark.kind, x: mark.x, y: mark.y, code: mark.code, zone: mark.zone, outline: mark.outline })),
    }
  }
  const candidate = record.candidates.find((entry) => entry.hideId === hideId)
  if (!candidate) return null
  return { hideId, code: candidate.code, shadeGroupId: null, gradeId: null, measuredArea: null, areaUom: candidate.areaUom, declaredArea: numberOf(candidate.area), marks: [] }
}

/** A scanned or typed hide tag among the sample's hides and the lot's candidates (case and spaces aside). */
export function hideByCode(record: Pick<RecordFacts, 'hides' | 'candidates'>, code: string): { readonly hideId: string; readonly inSample: boolean; readonly whole: boolean } | null {
  const key = code.trim().toUpperCase().replace(/\s+/g, '')
  const result = record.hides.find((hide) => hide.code.toUpperCase() === key)
  if (result) return { hideId: result.hideId, inSample: true, whole: true }
  const candidate = record.candidates.find((entry) => entry.code.toUpperCase() === key)
  return candidate ? { hideId: candidate.hideId, inSample: false, whole: candidate.whole } : null
}

/** Why a hide cannot be put in the sample now: it is not whole (cut already), or the sample is full; null: it may. */
export function hideHeld(record: Pick<RecordFacts, 'hides' | 'candidates' | 'inspection'>, hideId: string): 'notWhole' | 'sampleFull' | null {
  if (record.hides.some((hide) => hide.hideId === hideId)) return null
  const candidate = record.candidates.find((entry) => entry.hideId === hideId)
  if (candidate && !candidate.whole) return 'notWhole'
  return record.hides.length >= record.inspection.sampleSize ? 'sampleFull' : null
}

/** The hides of the lot to offer next: whole ones not in the sample, while the sample has room. */
export function nextCandidates<C extends { readonly whole: boolean }>(record: { readonly hides: readonly unknown[]; readonly inspection: { readonly sampleSize: number }; readonly candidates: readonly C[] }): C[] {
  return record.hides.length >= record.inspection.sampleSize ? [] : record.candidates.filter((candidate) => candidate.whole)
}

/** The area measured against the tannery's, in percent (+ over, − short), and its tone; null until measured. */
export function areaDifference(draft: Pick<HideDraft, 'measuredArea' | 'declaredArea'>, tolerancePercent: number): { readonly percent: number; readonly outcome: 'WITHIN' | 'SHORT' | 'OVER' } | null {
  if (draft.measuredArea === null || draft.declaredArea <= 0) return null
  const percent = Math.round(((draft.measuredArea - draft.declaredArea) / draft.declaredArea) * 10_000) / 100
  return { percent, outcome: Math.abs(percent) <= tolerancePercent ? 'WITHIN' : percent < 0 ? 'SHORT' : 'OVER' }
}

/** The worst defect class of the marks (a hide counts once, under it); a defect with no class counts MAJOR (B-W2b-98). */
export function worstOf(marks: readonly MarkFacts[], classOf: (code: string) => 'CRITICAL' | 'MAJOR' | 'MINOR' | null): 'CRITICAL' | 'MAJOR' | 'MINOR' | null {
  const rank = { CRITICAL: 3, MAJOR: 2, MINOR: 1 } as const
  let worst: 'CRITICAL' | 'MAJOR' | 'MINOR' | null = null
  for (const mark of marks) {
    if (mark.kind !== 'DEFECT' || !mark.code) continue
    const klass = classOf(mark.code) ?? 'MAJOR'
    if (worst === null || rank[klass] > rank[worst]) worst = klass
  }
  return worst
}

/** The hide's write: everything the bench knows of it, with the decision (one write per hide: Accept or Reject). */
export function hidePayload(inspectionId: string, draft: HideDraft, decision: UnitDecision | null) {
  return {
    what: 'HIDE' as const,
    inspectionId,
    hideId: draft.hideId,
    ...(draft.measuredArea !== null ? { measuredArea: quantityText(draft.measuredArea), areaUom: draft.areaUom } : {}),
    shadeGroupId: draft.shadeGroupId,
    gradeId: draft.gradeId,
    marks: draft.marks.map((mark) =>
      mark.kind === 'DEFECT'
        ? { kind: 'DEFECT' as const, x: round4(mark.x), y: round4(mark.y), code: mark.code ?? null, ...(mark.zone ? { zone: mark.zone } : {}) }
        : { kind: 'ZONE' as const, x: round4(mark.x), y: round4(mark.y), zone: mark.zone ?? null, outline: (mark.outline ?? []).map((point) => ({ x: round4(point.x), y: round4(point.y) })) },
    ),
    decision,
  }
}

const round4 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000

// ---- the hide map (design part HideMap: the outline, defect marks, grade zones A/B/C, + / − zoom, no pinch or drag) ------------

/** The zoom steps of the map (+ / − buttons; the view follows the cross). */
export const ZOOMS = [1, 1.5, 2, 3] as const

/** What a tap on the map does: place the defect picked, add a point to the zone being drawn. */
export type MapTool = { readonly kind: 'defect'; readonly code: string | null } | { readonly kind: 'zone'; readonly zone: string | null; readonly points: readonly { readonly x: number; readonly y: number }[] }

/** A point of the map, kept on the hide (0..1 on each axis). */
export const onHide = (x: number, y: number): { x: number; y: number } => ({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })

/** Why a tap places nothing: no defect picked, no grade picked, the hide full of marks; null: it places. */
export function tapHeld(tool: MapTool, marks: readonly MarkFacts[]): 'pickDefect' | 'pickZone' | 'full' | 'outlineFull' | null {
  if (marks.length >= MARK_LIMIT) return 'full'
  if (tool.kind === 'defect') return tool.code ? null : 'pickDefect'
  if (!tool.zone) return 'pickZone'
  return tool.points.length >= OUTLINE_LIMIT ? 'outlineFull' : null
}

/** A tap at (x, y): a defect mark placed, or a point added to the zone being drawn. */
export function tapMap(tool: MapTool, marks: readonly MarkFacts[], x: number, y: number): { readonly tool: MapTool; readonly marks: readonly MarkFacts[] } {
  if (tapHeld(tool, marks)) return { tool, marks }
  const at = onHide(x, y)
  if (tool.kind === 'defect') return { tool, marks: [...marks, { kind: 'DEFECT', x: at.x, y: at.y, code: tool.code, zone: null, outline: null }] }
  return { tool: { ...tool, points: [...tool.points, at] }, marks }
}

/** The zone drawn so far closed into a mark (at least three points): its place is the outline's centre. */
export function closeZone(tool: MapTool, marks: readonly MarkFacts[]): { readonly tool: MapTool; readonly marks: readonly MarkFacts[] } | null {
  if (tool.kind !== 'zone' || !tool.zone || tool.points.length < 3 || marks.length >= MARK_LIMIT) return null
  const x = tool.points.reduce((sum, point) => sum + point.x, 0) / tool.points.length
  const y = tool.points.reduce((sum, point) => sum + point.y, 0) / tool.points.length
  return { tool: { ...tool, points: [] }, marks: [...marks, { kind: 'ZONE', x, y, code: null, zone: tool.zone, outline: tool.points }] }
}

/** The view box of the map at a zoom, centred on the cross and kept on the hide (units of the 1000 × 700 drawing). */
export function viewBoxOf(zoom: number, centre: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const width = 1000 / zoom
  const height = 700 / zoom
  const x = Math.min(1000 - width, Math.max(0, centre.x * 1000 - width / 2))
  const y = Math.min(700 - height, Math.max(0, centre.y * 700 - height / 2))
  return { x, y, width, height }
}

/** The cross moved by the arrow keys (a step of a fiftieth, smaller when zoomed in). */
export const moveCross = (cross: { readonly x: number; readonly y: number }, dx: number, dy: number, zoom: number) => onHide(cross.x + dx / (50 * zoom), cross.y + dy / (50 * zoom))

// ---- fabric rolls by the 4-point system (QHS-032) -----------------------------------------------------------------------------

export interface RollDraft {
  /** The roll's tag on this lot (RL-…), or null: the supplier's roll number is `rollRef`. */
  readonly rollId: string | null
  readonly rollRef: string
  /** What the screen calls it: the tag's code, else the supplier's number. */
  readonly label: string
  readonly counts: readonly [number, number, number, number]
  readonly widthCm: number | null
  readonly lengthM: number | null
  /** The tag carries width and length (the API takes them from it). */
  readonly fromTag: boolean
}

/** The roll a scanned or typed code names: a roll of the sample, a tag of the lot, else the supplier's roll number. */
export function rollDraftFor(
  record: { readonly rolls: readonly { readonly rollRef: string; readonly roll: { readonly id: string; readonly code: string } | null; readonly onePoint: number; readonly twoPoint: number; readonly threePoint: number; readonly fourPoint: number; readonly widthCm: string; readonly lengthM: string }[]; readonly rollCandidates: readonly { readonly rollId: string; readonly code: string; readonly supplierRollRef: string | null; readonly length: string; readonly uom: string; readonly widthCm: string | null }[] },
  code: string,
): RollDraft {
  const key = code.trim().toUpperCase()
  const known = record.rolls.find((roll) => roll.rollRef.toUpperCase() === key || roll.roll?.code.toUpperCase() === key)
  if (known) {
    return { rollId: known.roll?.id ?? null, rollRef: known.rollRef, label: known.roll?.code ?? known.rollRef, counts: [known.onePoint, known.twoPoint, known.threePoint, known.fourPoint], widthCm: numberOf(known.widthCm), lengthM: numberOf(known.lengthM), fromTag: known.roll !== null }
  }
  const tag = record.rollCandidates.find((roll) => roll.code.toUpperCase() === key || roll.supplierRollRef?.toUpperCase() === key)
  if (tag) {
    const metres = numberOf(tag.length) / (tag.uom === 'CM' ? 100 : tag.uom === 'MM' ? 1000 : 1)
    return { rollId: tag.rollId, rollRef: tag.code, label: tag.code, counts: [0, 0, 0, 0], widthCm: tag.widthCm !== null ? numberOf(tag.widthCm) : null, lengthM: metres > 0 ? metres : null, fromTag: tag.widthCm !== null && metres > 0 }
  }
  return { rollId: null, rollRef: code.trim(), label: code.trim(), counts: [0, 0, 0, 0], widthCm: null, lengthM: null, fromTag: false }
}

export const pointsOf = (counts: RollDraft['counts']): number => counts[0] + 2 * counts[1] + 3 * counts[2] + 4 * counts[3]

/** Points per 100 square yards, as the database computes them (two decimals); null until width and length are known. */
export function per100Of(draft: Pick<RollDraft, 'counts' | 'widthCm' | 'lengthM'>): number | null {
  if (!draft.widthCm || !draft.lengthM) return null
  const yards = (draft.widthCm / 100) * draft.lengthM * 1.19599004630108
  return yards > 0 ? Math.round(((pointsOf(draft.counts) * 100) / yards) * 100) / 100 : null
}

/** Why a roll's decision waits: its width or length unknown; null: it may be decided. */
export const rollHeld = (draft: Pick<RollDraft, 'widthCm' | 'lengthM'>): 'width' | 'length' | null => (!draft.widthCm ? 'width' : !draft.lengthM ? 'length' : null)

/** A new roll when the sample's rolls are all recorded is refused (the API says so too). */
export const rollSampleFull = (record: { readonly rolls: readonly { readonly rollRef: string }[]; readonly inspection: { readonly sampleSize: number } }, draft: Pick<RollDraft, 'rollRef'>): boolean =>
  !record.rolls.some((roll) => roll.rollRef === draft.rollRef) && record.rolls.length >= record.inspection.sampleSize

// ---- components (QHS-033; EN 1621-1/-2) ----------------------------------------------------------------------------------------

export interface ComponentDraft {
  /** The checklist's line (1 … 60). */
  readonly seq: number
  readonly kind: ComponentKind | null
  readonly protectorType: ProtectorType | null
  readonly certificateId: string | null
  /** The marking read on the piece matches the certificate (standard, level, type): yes, no, or not said yet. */
  readonly markingOk: boolean | null
  readonly checked: number
  readonly defective: number
}

/** A line of the checklist as the bench edits it: the one recorded, else a new one after the last. */
export function componentDraftOf(
  record: { readonly components: readonly { readonly seq: number; readonly kind: ComponentKind; readonly protectorType: string | null; readonly certificate: { readonly id: string; readonly standard: string } | null; readonly marking: string | null; readonly checkedQuantity: number; readonly defectiveQuantity: number }[]; readonly inspection: { readonly sampleSize: number }; readonly choices: { readonly coveringCertificate: { readonly id: string } | null } },
  seq: number | null,
): ComponentDraft {
  const line = seq === null ? null : record.components.find((entry) => entry.seq === seq)
  if (line) {
    return { seq: line.seq, kind: line.kind, protectorType: line.protectorType === 'A' || line.protectorType === 'B' ? line.protectorType : null, certificateId: line.certificate?.id ?? null, markingOk: line.marking ? true : line.kind === 'PROTECTOR' ? null : null, checked: line.checkedQuantity, defective: line.defectiveQuantity }
  }
  const next = record.components.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1
  return { seq: next, kind: null, protectorType: null, certificateId: record.choices.coveringCertificate?.id ?? null, markingOk: null, checked: Math.max(1, record.inspection.sampleSize), defective: 0 }
}

export type ComponentReason = 'defective' | 'noCertificate' | 'noType' | 'marking'

/** What the line suggests, and why (= factory-domain componentVerdict before the certificate's dates, which the API checks). */
export function componentSuggestion(draft: ComponentDraft): { readonly suggested: 'ACCEPTED' | 'REJECTED'; readonly reasons: readonly ComponentReason[] } {
  const reasons: ComponentReason[] = []
  if (draft.defective > 0) reasons.push('defective')
  if (draft.kind === 'PROTECTOR') {
    if (!draft.certificateId) reasons.push('noCertificate')
    if (draft.markingOk !== true) reasons.push('marking')
    if (!draft.protectorType) reasons.push('noType')
  }
  const rejects = draft.defective > 0 || (draft.kind === 'PROTECTOR' && !draft.certificateId)
  return { suggested: rejects ? 'REJECTED' : 'ACCEPTED', reasons }
}

/** Why the line cannot be saved yet: no kind, nothing looked at; null: it may. */
export const componentHeld = (draft: ComponentDraft): 'kind' | 'checked' | null => (!draft.kind ? 'kind' : draft.checked < 1 ? 'checked' : null)

/** The line's write: the marking is the certificate's standard and the type when the inspector says the piece reads so. */
export function componentBody(draft: ComponentDraft, certificates: readonly { readonly id: string; readonly standard: string }[], version: number, decision: UnitDecision) {
  const certificate = certificates.find((entry) => entry.id === draft.certificateId) ?? null
  const marking = draft.kind === 'PROTECTOR' && draft.markingOk === true && certificate ? `${certificate.standard}${draft.protectorType ? ` · ${draft.protectorType}` : ''}` : null
  return {
    version,
    kind: draft.kind ?? 'OTHER',
    marking,
    protectorType: draft.kind === 'PROTECTOR' ? draft.protectorType : null,
    certificateId: draft.certificateId,
    checkedQuantity: Math.max(1, draft.checked),
    defectiveQuantity: Math.min(Math.max(0, draft.defective), Math.max(1, draft.checked)),
    decision,
  }
}

// ---- the plan's checks ----------------------------------------------------------------------------------------------------------

/** One result per check for the whole sample (B-W2b-109's rule): the first unit's. */
export const SAMPLE_UNIT = 1

export const answerOf = (check: Pick<CheckFacts, 'answers'>) => check.answers.find((answer) => answer.sampleIndex === SAMPLE_UNIT) ?? check.answers[0] ?? null

/** Mandatory checks still to answer on the floor (instructions are read; free words are the office's and still count). */
export const checksLeft = <C extends Pick<CheckFacts, 'mandatory' | 'type' | 'answers'>>(checks: readonly C[]): C[] => checks.filter((check) => check.mandatory && check.type !== 'INSTRUCTION' && answerOf(check) === null)

/** Critical checks answered FAIL: the whole lot is never accepted over them. */
export const failedCritical = <C extends Pick<CheckFacts, 'checkClass' | 'answers'>>(checks: readonly C[]): C[] => checks.filter((check) => check.checkClass === 'CRITICAL' && answerOf(check)?.outcome === 'FAIL')

/** The WHOLE results list with some checks' answers put in (each save sends them all; the office keeps them by check and unit). */
export function withAnswers(checks: readonly Pick<CheckFacts, 'id' | 'answers'>[], answers: readonly { readonly checkId: string; readonly outcome: 'PASS' | 'FAIL'; readonly value?: string | null }[]) {
  const given = new Map(answers.map((answer) => [answer.checkId, answer]))
  const out: { planCheckId: string; sampleIndex: number; outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; value?: string | null }[] = []
  for (const check of checks) {
    const now = given.get(check.id)
    for (const answer of check.answers) {
      if (now && answer.sampleIndex === SAMPLE_UNIT) continue
      out.push({ planCheckId: check.id, sampleIndex: answer.sampleIndex, outcome: answer.outcome, ...(answer.value !== null ? { value: answer.value } : {}) })
    }
    if (now) out.push({ planCheckId: check.id, sampleIndex: SAMPLE_UNIT, outcome: now.outcome, ...(now.value !== undefined && now.value !== null ? { value: now.value } : {}) })
  }
  return out
}

// ---- goods back from a workshop (QHS-036) --------------------------------------------------------------------------------------

/** The receipt's lines with pieces to inspect (good and defective), in order. */
export const inspectedLines = <L extends ReceiptLineFacts>(lines: readonly L[]): L[] => lines.filter((line) => line.good + line.defective > 0).sort((a, b) => a.seq - b.seq)

/** The quantities when these bundles are rejected (= factory-domain receiptSplit): accepted = good of the lines kept; rejected = the rest. */
export function receiptSplit(lines: readonly Pick<ReceiptLineFacts, 'id' | 'good' | 'defective'>[], rejected: ReadonlySet<string>): { readonly accepted: number; readonly rejected: number } {
  const lot = lines.reduce((sum, line) => sum + line.good + line.defective, 0)
  const accepted = lines.filter((line) => !rejected.has(line.id)).reduce((sum, line) => sum + line.good, 0)
  return { accepted, rejected: lot - accepted }
}

// ---- the decision (QHS-034) -----------------------------------------------------------------------------------------------------

export interface DecisionDraft {
  readonly accepted: number | null
  readonly rejected: number | null
  readonly toSort: number | null
  /** Goods back from a workshop: the bundles (receipt lines) rejected. */
  readonly rejectedLines: readonly string[]
}

const lengthIn = (metres: number, uom: string): number => metres * (uom === 'CM' ? 100 : uom === 'MM' ? 1000 : 1)
const rollLength = (record: Pick<RecordFacts, 'rolls' | 'inspection'>, decision: UnitDecision): number => record.rolls.filter((roll) => roll.decision === decision).reduce((sum, roll) => sum + lengthIn(numberOf(roll.lengthM), record.inspection.uom), 0)

/**
 * What the pads start with: a workshop's split from its bundles; a sample that passes whole, the whole lot accepted; else what the
 * sample says (hides or rolls accepted and rejected) with the rest to sort — a draft the API would take, the inspector changes it.
 */
export function decisionDefault(record: RecordFacts): DecisionDraft {
  const lot = numberOf(record.inspection.lotSize)
  if (record.inspection.subject === 'WORKSHOP' && record.receipt) {
    const split = receiptSplit(inspectedLines(record.receipt.lines), new Set())
    return { accepted: split.accepted, rejected: split.rejected, toSort: 0, rejectedLines: [] }
  }
  const sampleDone = sampleComplete(record)
  if (record.inspection.byHide) {
    const accepted = record.hides.filter((hide) => hide.decision === 'ACCEPTED').length
    const rejected = record.hides.filter((hide) => hide.decision === 'REJECTED').length
    if (sampleDone && rejected === 0 && record.result.resultNow === 'PASS') return { accepted: lot, rejected: 0, toSort: 0, rejectedLines: [] }
    return { accepted, rejected, toSort: Math.max(0, lot - accepted - rejected), rejectedLines: [] }
  }
  if (record.inspection.byRoll) {
    const accepted = rollLength(record, 'ACCEPTED')
    const rejected = rollLength(record, 'REJECTED')
    if (sampleDone && rejected === 0 && record.result.resultNow === 'PASS') return { accepted: lot, rejected: 0, toSort: 0, rejectedLines: [] }
    return { accepted: round(accepted), rejected: round(rejected), toSort: round(Math.max(0, lot - accepted - rejected)), rejectedLines: [] }
  }
  return record.result.resultNow === 'PASS' ? { accepted: lot, rejected: 0, toSort: 0, rejectedLines: [] } : { accepted: 0, rejected: lot, toSort: 0, rejectedLines: [] }
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000

/** Every unit of the sample is recorded (hides, rolls); a counted lot's sample is taken as inspected at signing (B-W2b-111 gap 8). */
export function sampleComplete(record: Pick<RecordFacts, 'inspection' | 'hides' | 'rolls'>): boolean {
  if (record.inspection.byHide) return record.hides.length >= record.inspection.sampleSize
  if (record.inspection.byRoll) return record.rolls.length >= record.inspection.sampleSize
  return true
}

/** A workshop's draft after a bundle is toggled: the pads follow the bundles (no "to sort"). */
export function withLineToggled(record: RecordFacts, draft: DecisionDraft, lineId: string): DecisionDraft {
  const rejected = new Set(draft.rejectedLines)
  if (rejected.has(lineId)) rejected.delete(lineId)
  else rejected.add(lineId)
  const split = receiptSplit(inspectedLines(record.receipt?.lines ?? []), rejected)
  return { accepted: split.accepted, rejected: split.rejected, toSort: 0, rejectedLines: [...rejected] }
}

export type DecisionHeld =
  | { readonly key: 'notYours' }
  | { readonly key: 'notOpen' }
  | { readonly key: 'offline' }
  | { readonly key: 'waiting'; readonly count: number }
  | { readonly key: 'empty' }
  | { readonly key: 'whole' }
  | { readonly key: 'sum'; readonly lot: number; readonly sum: number }
  | { readonly key: 'hidesUndecided'; readonly codes: readonly string[] }
  | { readonly key: 'rollsUndecided'; readonly count: number }
  | { readonly key: 'componentsUndecided'; readonly count: number }
  | { readonly key: 'below'; readonly pad: 'accepted' | 'rejected' | 'toSort'; readonly min: number }
  | { readonly key: 'outsideBeforeWhole'; readonly done: number; readonly sample: number }
  | { readonly key: 'failedSplit'; readonly accepted: number }
  | { readonly key: 'hard' }
  | { readonly key: 'mandatory'; readonly count: number }
  | { readonly key: 'override'; readonly result: 'PASS' | 'FAIL' }
  | { readonly key: 'workshopSort' }

/**
 * What keeps Sign held, in order (= factory-domain decisionProblems, rollDecisionProblems and receiptDecision as far as a floor
 * screen decides: the API decides them all again before the PIN and inside the command). The whole lot decided against the rules'
 * result needs written words: the office's.
 */
export function decisionHeld(record: RecordFacts, draft: DecisionDraft, place: { readonly online: boolean; readonly waiting: number }): DecisionHeld[] {
  const held: DecisionHeld[] = []
  if (record.inspection.status !== 'OPEN') return [{ key: 'notOpen' }]
  if (!record.may.decide) return [{ key: 'notYours' }]
  if (!place.online) held.push({ key: 'offline' })
  if (place.waiting > 0) held.push({ key: 'waiting', count: place.waiting })
  const { accepted, rejected, toSort } = draft
  if (accepted === null || rejected === null || toSort === null) return [...held, { key: 'empty' }]
  const lot = numberOf(record.inspection.lotSize)
  const whole = wholeUnits(record.inspection.uom)
  if (whole && ![accepted, rejected, toSort].every(Number.isInteger)) held.push({ key: 'whole' })
  const sum = round(accepted + rejected + toSort)
  if (sum !== round(lot)) held.push({ key: 'sum', lot, sum })
  const undecidedHides = record.hides.filter((hide) => hide.decision === null).map((hide) => hide.code)
  if (undecidedHides.length > 0) held.push({ key: 'hidesUndecided', codes: undecidedHides })
  const undecidedRolls = record.rolls.filter((roll) => roll.decision === null).length
  if (undecidedRolls > 0) held.push({ key: 'rollsUndecided', count: undecidedRolls })
  const undecidedLines = record.components.filter((line) => line.decision === null).length
  if (undecidedLines > 0) held.push({ key: 'componentsUndecided', count: undecidedLines })
  if (record.inspection.subject === 'WORKSHOP') {
    if (toSort !== 0) held.push({ key: 'workshopSort' })
    return held
  }
  const wholeAccepted = accepted === lot
  const wholeRejected = rejected === lot
  const hard = record.inspection.found.critical > 0 || failedCritical(record.checks).length > 0
  if (record.inspection.byHide) {
    const tally = { accepted: record.hides.filter((hide) => hide.decision === 'ACCEPTED').length, rejected: record.hides.filter((hide) => hide.decision === 'REJECTED').length, toSort: record.hides.filter((hide) => hide.decision === 'TO_SORT').length }
    if (accepted < tally.accepted) held.push({ key: 'below', pad: 'accepted', min: tally.accepted })
    if (rejected < tally.rejected) held.push({ key: 'below', pad: 'rejected', min: tally.rejected })
    if (toSort < tally.toSort) held.push({ key: 'below', pad: 'toSort', min: tally.toSort })
    if (record.hides.length < record.inspection.sampleSize && accepted > tally.accepted) held.push({ key: 'outsideBeforeWhole', done: record.hides.length, sample: record.inspection.sampleSize })
    else if (!wholeAccepted && !wholeRejected && record.result.resultNow === 'FAIL' && accepted > tally.accepted) held.push({ key: 'failedSplit', accepted: tally.accepted })
  }
  if (record.inspection.byRoll) {
    const rejectedMin = Math.min(lot, rollLength(record, 'REJECTED'))
    const toSortMin = Math.min(lot - rejectedMin, rollLength(record, 'TO_SORT'))
    const acceptedLength = rollLength(record, 'ACCEPTED')
    if (rejected < round(rejectedMin)) held.push({ key: 'below', pad: 'rejected', min: round(rejectedMin) })
    if (toSort < round(toSortMin)) held.push({ key: 'below', pad: 'toSort', min: round(toSortMin) })
    if (record.rolls.length < record.inspection.sampleSize && accepted > round(acceptedLength)) held.push({ key: 'outsideBeforeWhole', done: record.rolls.length, sample: record.inspection.sampleSize })
  }
  if (wholeAccepted && hard) held.push({ key: 'hard' })
  if (wholeAccepted && checksLeft(record.checks).length > 0) held.push({ key: 'mandatory', count: checksLeft(record.checks).length })
  if ((wholeAccepted && record.result.resultNow === 'FAIL' && !hard) || (wholeRejected && record.result.resultNow === 'PASS')) held.push({ key: 'override', result: record.result.resultNow })
  return held
}

/** What follows the signed decision (factory-domain nextStepOf): the whole lot to release or reject, the rest to sort, or a part. */
export function nextStepOf(quantities: { readonly accepted: string; readonly rejected: string; readonly toSort: string }, lotSize: string): NextStep {
  const lot = numberOf(lotSize)
  if (numberOf(quantities.accepted) === lot) return 'RELEASE'
  if (numberOf(quantities.rejected) === lot) return 'REJECT'
  if (numberOf(quantities.toSort) > 0) return 'SORT'
  return 'RELEASE_PART'
}

// ---- the tablet's queue -----------------------------------------------------------------------------------------------------------

/** Writes of this inspection still kept on the tablet: the signature waits for them (the office signs what it holds). */
export function waitingWrites(items: readonly { readonly kind: string; readonly state: string; readonly payload: unknown }[], inspectionId: string): number {
  return items.filter((item) => item.kind === 'quality.incoming.record' && item.state === 'waiting' && (item.payload as { inspectionId?: unknown } | null)?.inspectionId === inspectionId).length
}

// ---- a write kept on the tablet moves the record on screen at once (the office answers it when the network is back) -----------

/**
 * The record as it will be once a kept write is applied (B-W2b-109's `applyKept` for this bench): a hide put in the sample or
 * changed (its shade, grade, marks with their words and class, area, decision) or taken out, the plan checks answered. What
 * the office computes (the found counts, the result, the area check) waits for its answer.
 */
export function applyKept(record: IncomingRecord, payload: BenchPayload): IncomingRecord {
  if (payload.what === 'RESULTS') {
    const checks = record.checks.map((check) => {
      const mine = payload.results.filter((result) => result.planCheckId === check.id)
      if (mine.length === 0) return check
      return { ...check, answers: mine.map((result) => ({ id: `kept-${check.id}-${result.sampleIndex}`, sampleIndex: result.sampleIndex, outcome: result.outcome, value: result.value ?? null, note: null })) }
    })
    return { ...record, checks }
  }
  if (payload.what === 'HIDE_REMOVED') {
    const gone = record.hides.find((hide) => hide.hideId === payload.hideId)
    if (!gone) return record
    const hides = record.hides.filter((hide) => hide.hideId !== payload.hideId)
    const candidates = [...record.candidates, { hideId: gone.hideId, code: gone.code, state: gone.state, whole: true, area: gone.receivedArea.area, areaUom: gone.receivedArea.uom }]
    return { ...record, hides, candidates, progress: progressOf(record, hides) }
  }
  const existing = record.hides.find((hide) => hide.hideId === payload.hideId)
  const candidate = record.candidates.find((entry) => entry.hideId === payload.hideId)
  if (!existing && !candidate) return record
  const shade = payload.shadeGroupId ? (record.choices.shadeGroups.find((group) => group.id === payload.shadeGroupId) ?? null) : null
  const grade = payload.gradeId ? (record.choices.grades.find((entry) => entry.id === payload.gradeId) ?? null) : null
  const defects = new Map(record.choices.hideDefects.map((defect) => [defect.code, defect]))
  const marks = (payload.marks ?? []).map((mark) => {
    const defect = mark.kind === 'DEFECT' && mark.code ? defects.get(mark.code) : undefined
    return { kind: mark.kind, x: mark.x, y: mark.y, code: mark.code ?? null, zone: mark.zone ?? null, outline: [...(mark.outline ?? [])], note: null, defectClass: defect?.defectClass ?? (mark.kind === 'DEFECT' ? ('MAJOR' as const) : null), labelIt: defect?.labelIt ?? null, labelEn: defect?.labelEn ?? null }
  })
  const base: HideResult = existing ?? {
    id: `kept-${payload.hideId}`,
    hideId: payload.hideId,
    code: candidate!.code,
    seq: record.hides.reduce((max, hide) => Math.max(max, hide.seq), 0) + 1,
    state: candidate!.state,
    receivedArea: { area: candidate!.area, uom: candidate!.areaUom },
    measured: false,
    declaredArea: null,
    measuredArea: candidate!.area,
    areaUom: candidate!.areaUom,
    areaCheck: null,
    shadeGroup: null,
    grade: null,
    marks: [],
    worstClass: null,
    decision: null,
    note: null,
    version: 0,
  }
  const measured = payload.measuredArea !== undefined && payload.measuredArea !== null
  const hide: HideResult = {
    ...base,
    measured: base.measured || measured,
    measuredArea: measured ? payload.measuredArea! : base.measuredArea,
    areaCheck: measured ? null : base.areaCheck,
    shadeGroup: shade ? { id: shade.id, label: shade.label, outOfShade: shade.outOfShade } : null,
    grade: grade ? { id: grade.id, code: grade.code } : null,
    marks,
    worstClass: worstOf(marks, (code) => defects.get(code)?.defectClass ?? null),
    decision: payload.decision ?? null,
  }
  const hides = existing ? record.hides.map((entry) => (entry.hideId === hide.hideId ? hide : entry)) : [...record.hides, hide]
  const candidates = record.candidates.filter((entry) => entry.hideId !== payload.hideId)
  return { ...record, hides, candidates, progress: progressOf(record, hides) }
}

function progressOf(record: IncomingRecord, hides: readonly HideResult[]): IncomingRecord['progress'] {
  const count = (decision: UnitDecision) => hides.filter((hide) => hide.decision === decision).length
  const done = hides.length
  const sampleSize = record.inspection.sampleSize
  return { done, sampleSize, remaining: Math.max(0, sampleSize - done), decided: hides.filter((hide) => hide.decision !== null).length, accepted: count('ACCEPTED'), rejected: count('REJECTED'), toSort: count('TO_SORT'), undecided: hides.filter((hide) => hide.decision === null).length }
}

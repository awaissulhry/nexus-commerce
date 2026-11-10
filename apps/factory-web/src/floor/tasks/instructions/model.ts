import { FLOOR_PROBLEMS, CHANGE_LIMITS, type FloorProblem } from '@nexus/factory-domain/product/changes/rules'
import type { Disposition } from '@nexus/factory-domain/product/versions/drift'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { OpenItem } from '../scans/timing'
import type { DueInstruction, FloorInstruction, FloorSpec, InstructionStep, MineAnswer, NewerSpec } from './api'

/**
 * Spec & instructions (SCR-174, B-W2b-232; design floor.instructions; MES-110, MES-119, PRD-195, PRD-258, PRD-259): the rules
 * without a screen, held by `instructions.vitest.test.ts`. What opens before Start, when Seen may be tapped ("Look at every step
 * first"), one step per screen, the zoom, the Spec changed banner in floor words (never the API's English), the spec's rows, the
 * spec problem's body and why Send waits, the count of My work's "New instructions N". Never money: no answer here holds any.
 */

export const NS = 'floor-instructions'

export type Due = 'FIRST' | 'CHANGED'

// ---- what waits for the person --------------------------------------------------------------------------------------------

/** Seen on this tablet (sent, or saved in the queue): per person and version, so the next read's stale "due" does not reopen it. */
export const seenKey = (workerId: string, versionId: string): string => `${workerId}:${versionId}`

/** Whether Seen waits for this person: the API's `due`, unless this tablet already holds their Seen of this version. */
export function dueOf(answer: Pick<FloorInstruction, 'instruction' | 'acknowledgement'>, seenHere: (versionId: string) => boolean): Due | null {
  const version = answer.instruction?.version
  if (!version || !answer.acknowledgement?.due) return null
  return seenHere(version.id) ? null : answer.acknowledgement.due
}

/** What the operation card knows of the instruction in force (B-W2b-69's StepsPanel and bar read it). */
export interface InstructionFlag {
  readonly instructionId: string
  readonly number: string
  readonly versionId: string
  readonly versionNumber: number
  readonly due: Due | null
}

export function flagOf(answer: FloorInstruction, seenHere: (versionId: string) => boolean): InstructionFlag | null {
  const instruction = answer.instruction
  if (!instruction) return null
  return { instructionId: instruction.id, number: instruction.number, versionId: instruction.version.id, versionNumber: instruction.version.number, due: dueOf(answer, seenHere) }
}

/**
 * Opens before Start (MES-110; FI9:01): a version whose Seen waits opens once per visit before that person's Start of it; Back
 * returns to the bundle and the next Start goes (Seen is a record of what was shown, not a gate the API holds).
 */
export function opensBeforeStart(flag: InstructionFlag | null | undefined, openedBefore: (versionId: string) => boolean): boolean {
  return Boolean(flag?.due) && !openedBefore(flag!.versionId)
}

/** My work's "New instructions N" (FI9:02): the versions waiting for this person's Seen, less those Seen on this tablet. */
export function dueCount(mine: Pick<MineAnswer, 'due'> | null, seenHere: (versionId: string) => boolean): number {
  return mine ? mine.due.filter((row) => !seenHere(row.versionId)).length : 0
}

/** The due rows still waiting, newest first. */
export function dueRows(mine: Pick<MineAnswer, 'due'> | null, seenHere: (versionId: string) => boolean): readonly DueInstruction[] {
  if (!mine) return []
  return mine.due.filter((row) => !seenHere(row.versionId)).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
}

/**
 * "Opens for the current bundle" (design sec:open): the person's open work on this tablet, the running one first. One running
 * bundle opens by itself; the rest are rows to tap.
 */
export function inHand(items: readonly OpenItem[]): readonly OpenItem[] {
  const open = items.filter((item) => item.state === 'RUNNING' || item.state === 'PAUSED')
  const seen = new Set<string>()
  return [...open.filter((item) => item.state === 'RUNNING'), ...open.filter((item) => item.state === 'PAUSED')].filter((item) => {
    const key = `${item.bundleId}:${item.operation.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The bundle that opens by itself: exactly one running. */
export function openByItself(items: readonly OpenItem[]): OpenItem | null {
  const running = inHand(items).filter((item) => item.state === 'RUNNING')
  return running.length === 1 ? running[0]! : null
}

/** A due row's bundle in hand, when one of the person's open bundles is at that operation (by its code). */
export function bundleForDue(row: Pick<DueInstruction, 'operation'>, items: readonly OpenItem[]): OpenItem | null {
  return inHand(items).find((item) => item.operation.code === row.operation.code) ?? null
}

// ---- one step per screen (design sec:steps) ---------------------------------------------------------------------------------

/** The step at an index, kept inside the list. */
export const clampStep = (index: number, count: number): number => (count <= 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), count - 1))

/** The steps shown so far (each index once, in order). */
export function withShown(shown: readonly number[], index: number): readonly number[] {
  return shown.includes(index) ? shown : [...shown, index].sort((a, b) => a - b)
}

/** Every step was on screen. */
export const allShown = (shown: readonly number[], count: number): boolean => count === 0 || Array.from({ length: count }, (_, index) => index).every((index) => shown.includes(index))

export type SeenHeld = { readonly key: 'steps'; readonly seen: number; readonly count: number } | { readonly key: 'busy' } | { readonly key: 'noSteps' } | null

/** Seen waits until the last step was shown ("Look at every step first"), and while it is being sent. */
export function seenHeld(input: { readonly count: number; readonly shown: readonly number[]; readonly busy: boolean }): SeenHeld {
  if (input.busy) return { key: 'busy' }
  if (input.count === 0) return null
  return allShown(input.shown, input.count) ? null : { key: 'steps', seen: input.shown.filter((index) => index < input.count).length, count: input.count }
}

/** The body Seen sends (and the queue keeps): the version and the language it was shown in (two letters, else the person's own). */
export function seenBody(answer: Pick<FloorInstruction, 'instruction' | 'language'>): { readonly versionId: string; readonly locale?: string } | null {
  const version = answer.instruction?.version
  if (!version) return null
  const language = answer.language.toLowerCase()
  return /^[a-z]{2}$/.test(language) ? { versionId: version.id, locale: language } : { versionId: version.id }
}

/** The words read aloud for a step: its number, the words and the safety note. */
export function readAloudText(step: Pick<InstructionStep, 'words' | 'safety'>, index: number): string {
  return [`${index + 1}. ${step.words}`, step.safety].filter(Boolean).join('. ')
}

/** The language a step is read in: the one its words are shown in, else the answer's. */
export const stepLanguage = (step: Pick<InstructionStep, 'shownIn'>, answer: Pick<FloorInstruction, 'language'>): string => step.shownIn ?? answer.language

// ---- the photo pop-up (pop:instructions.zoom: + / − and Close) ---------------------------------------------------------------

export const ZOOM_LEVELS = [1, 1.5, 2, 3] as const

export function zoomIn(level: number): number {
  return ZOOM_LEVELS.find((step) => step > level) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!
}

export function zoomOut(level: number): number {
  return [...ZOOM_LEVELS].reverse().find((step) => step < level) ?? ZOOM_LEVELS[0]
}

// ---- Spec changed (PRD-195) in floor words ----------------------------------------------------------------------------------

export interface NewerLine {
  /** A key of the floor-instructions catalogue. */
  readonly key: string
  readonly params: Readonly<Record<string, string | number>>
  readonly tone: 'warning' | 'danger'
  /** The office decided to rework to the new spec: its pages apply (the tablet has only the frozen ones). */
  readonly newPages: boolean
}

const STOPS: readonly Disposition[] = ['SCRAP', 'HOLD']

/**
 * The banner (B-W2b-220's `newer`): shown when the API says one is due — a newer released revision, or the work order's one
 * withdrawn — in the floor's words from the facts (state, revisions, the decision), never the API's English `message`.
 */
export function newerLine(spec: NewerSpec | null | undefined): NewerLine | null {
  if (!spec?.newer.banner) return null
  const pinned = spec.revision?.revision ?? 0
  const newer = spec.newer.newer?.revision ?? 0
  if (spec.newer.state === 'WITHDRAWN') return { key: 'spec.banner.withdrawn', params: { pinned }, tone: 'warning', newPages: false }
  const decision = spec.newer.decision
  if (!decision) return { key: 'spec.banner.newer', params: { pinned, newer }, tone: 'warning', newPages: false }
  return { key: `spec.banner.decided.${decision.disposition}`, params: { pinned, newer, changeOrder: decision.changeOrder }, tone: STOPS.includes(decision.disposition) ? 'danger' : 'warning', newPages: spec.newer.newPages }
}

// ---- the spec for this size (PRD-258) ---------------------------------------------------------------------------------------

/** A decimal the API writes ("1.85") in the screen's language ("1,85"); anything else as it is. */
export function decimalWords(text: string, locale: Locale): string {
  return /^-?\d+(\.\d+)?$/.test(text) ? formatNumber(Number(text), locale, { maximumFractionDigits: 4 }) : text
}

/** A measure as written: "48 – 50 cm", or one value, its numbers in the screen's language. */
export function measureText(measure: Pick<FloorSpec['size']['measures'][number], 'min' | 'max' | 'unit'>, locale: Locale = 'en'): string {
  const unit = measure.unit ? ` ${measure.unit}` : ''
  const min = measure.min === null ? null : decimalWords(measure.min, locale)
  const max = measure.max === null ? null : decimalWords(measure.max, locale)
  if (min !== null && max !== null && min !== max) return `${min} – ${max}${unit}`
  const one = min ?? max
  return one === null ? '—' : `${one}${unit}`
}

/** A material's name in the person's language (its own name when none is written). */
export function materialName(item: FloorSpec['materials'][number]['item'], locale: string): string {
  return item.nameI18n[locale]?.trim() || item.name
}

/** The machine settings as rows of label and value (only what is set). */
export function settingRows(setting: FloorInstruction['settings'][number], locale: string): { readonly key: string; readonly value: string }[] {
  const machine = setting.machineClass ? (locale === 'it' ? setting.machineClass.labelIt : setting.machineClass.labelEn) || setting.machineClass.code : null
  const rows: [string, string | null][] = [
    ['machine', machine],
    ['stitchType', setting.stitchType],
    ['needle', setting.needle],
    ['thread', setting.thread],
    ['stitchesPerCm', setting.stitchesPerCm],
    ['tension', setting.tension],
    ['foot', setting.foot],
    ['notes', setting.notes],
  ]
  return rows.flatMap(([key, value]) => (value && value.trim() ? [{ key, value }] : []))
}

// ---- Report a spec problem (PRD-259) ----------------------------------------------------------------------------------------

export const PROBLEMS: readonly FloorProblem[] = FLOOR_PROBLEMS
export const PROBLEM_NOTE_MAX = CHANGE_LIMITS.floorNote

export interface ProblemPhoto {
  readonly id: string
  readonly blob: Blob
  readonly name: string
}

export interface ProblemDraft {
  readonly problem: FloorProblem | null
  readonly note: string
  readonly photo: ProblemPhoto | null
  /** The camera is open. */
  readonly capture: boolean
  readonly busy: boolean
}

export const EMPTY_PROBLEM: ProblemDraft = Object.freeze({ problem: null, note: '', photo: null, capture: false, busy: false })

export type SendHeld = 'tile' | 'detail' | 'busy' | null

/** Why Send waits: a tile first; "Other" asks a few words; one send at a time. */
export function sendHeld(draft: ProblemDraft): SendHeld {
  if (draft.busy) return 'busy'
  if (!draft.problem) return 'tile'
  if (draft.problem === 'OTHER' && !draft.note.trim()) return 'detail'
  return null
}

/** The camera waits for the network (the photo goes up as soon as the request has its number; the report itself queues). */
export const photoHeld = (online: boolean): 'offline' | null => (online ? null : 'offline')

/**
 * The request's body (B-W2b-226 POST /product/floor/change-requests, the queue's `product.change.report` payload): the work
 * order, its operation and the bundle in hand, the tile, a few words. Never a person: the API names none on a floor request.
 */
export function problemBody(answer: Pick<FloorInstruction, 'workOrder' | 'operation' | 'bundle'>, draft: ProblemDraft): Readonly<Record<string, unknown>> | null {
  if (!draft.problem) return null
  const note = draft.note.trim().slice(0, PROBLEM_NOTE_MAX)
  return { workOrderId: answer.workOrder.id, workOrderOperationId: answer.operation.id, bundleId: answer.bundle.id, problem: draft.problem, ...(note ? { note } : {}) }
}

/** The photo's file name: the work order and the operation, never a person. */
export const photoName = (answer: Pick<FloorInstruction, 'workOrder' | 'operation'>): string => `${answer.workOrder.number}-op${answer.operation.seq}-spec-problem.jpg`.replace(/[^A-Za-z0-9._-]+/g, '-')

// ---- the API's refusals in words --------------------------------------------------------------------------------------------

/** Refusal codes this page says in its own words (Seen and the spec problem); any other: the general words. */
export const KNOWN_REFUSALS = ['NOT_PUBLISHED', 'CLIENT_ID_REUSED'] as const

export const isKnownRefusal = (code: string): code is (typeof KNOWN_REFUSALS)[number] => (KNOWN_REFUSALS as readonly string[]).includes(code)

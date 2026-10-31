import { reasonLabel } from '@nexus/factory-domain/reasons/rules'
import type { ReasonTone } from '@nexus/ui/floor/ReasonGrid/index'

/**
 * SCR-091 — the floor's reason picker (design floor.reasons; MES-125, QHS-007): ONE picker for every "why" on the floor,
 * over the reason lists the office keeps (B-W2a-18, `GET /reasons?list=`; the scans' own scrap and rework reasons, which
 * the bundle card carries; the defect library's picker, B-W2a-26; the few a screen fixes itself, like a split's rework /
 * recut / hold). Pure, so the tests hold it.
 *
 *   reasons   one shape for every source: the code, the words in Italian, English and the other floor languages, the
 *             office's icon (a DS tag icon id) and colour (a DS swatch), an example photo's address when the source has
 *             one, "asks for a note" (Other: no typing on the floor, a photo instead), the tile order
 *   tiles     the DS ReasonGrid's tiles: the word in the worker's language (factory-domain `reasonLabel`), the icon (the
 *             office's; the scan lists keep no icon yet, so their standard codes have a look of their own), the colour as
 *             a tone (tones only: a tenant colour is never painted, B-W2a-24)
 *   context   what the reason is for, before asking why ("Scrap · B-000123 · Op 30 Collar") and the running count
 *   held      a tile stays in view but cannot be picked: no network for the host's call, or a reason asking a written
 *             note where the call needs one (Hold lot: quality places that hold in the office)
 *   done      pick mode: held until a reason is picked; count mode: never held (no tap = nothing of that kind)
 * No person and no money anywhere (a floor session holds no price, cost or margin grain).
 */

/**
 * What the picker asks about: scrap, rework (Operation's counts), pause, put last (My work), defect, and — B-W2a-F6 — why
 * garments come off a bundle (split, SCR-095), why a lot is held at the bench (hold, SCR-097), why garments came back
 * rejected from a workshop (reject, SCR-181 Receive back).
 */
export const PICKER_PURPOSES = ['scrap', 'rework', 'pause', 'putLast', 'defect', 'split', 'hold', 'reject'] as const
export type PickerPurpose = (typeof PICKER_PURPOSES)[number]

export type PickerMode = 'pick' | 'count'

/** The mode each purpose asks in (design floor.reasons "grid": pick one for pause, help type, symptom; count for scrap, defects). */
export const MODE_OF: Readonly<Record<PickerPurpose, PickerMode>> = { scrap: 'count', rework: 'count', pause: 'pick', putLast: 'pick', defect: 'count', split: 'pick', hold: 'pick', reject: 'pick' }

/**
 * The reason list each purpose reads (`GET /reasons?list=`), or null when the host has the reasons already (the bundle
 * card's scan reasons; a split's three codes, which the API takes as they are).
 */
export const LIST_OF: Readonly<Record<PickerPurpose, string | null>> = { scrap: 'SCRAP', rework: 'REWORK', pause: 'PAUSE', putLast: 'PAUSE', defect: null, split: null, hold: 'HOLD', reject: 'REWORK' }

/**
 * The purposes whose call needs a written note for a reason that asks for more ("Other"): no typing on the floor, so that
 * reason stays in view, held with the words (B-W2a-75: a bench hold with Other is placed by quality in the office).
 */
export const NOTE_IN_OFFICE: ReadonlySet<PickerPurpose> = new Set<PickerPurpose>(['hold'])

export interface PickerReason {
  /** The tile's id: the code (unique inside one list). */
  readonly id: string
  /** SCRAP, REWORK, PAUSE … (B-W2a-18's lists) or DEFECT (the defect library). */
  readonly list: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  /** The office's icon: a DS tag icon id (factory-domain reasons/rules REASON_ICONS); null: none chosen. */
  readonly icon: string | null
  /** The office's colour: a DS swatch (REASON_COLOURS); null: none chosen. */
  readonly colour: string | null
  /** An example photo's address (the defect library's picture); null: none. */
  readonly photo: string | null
  /** The reason asks for more than its word ("Other"): on the floor a photo, never typing. */
  readonly needsDetail: boolean
  readonly sortOrder: number
  /** A short second line under the word (a screen's own reasons: "Back to be fixed"); none for the office's lists. */
  readonly hint?: string | null
}

/** A reason as `GET /reasons` answers it (platform/reasons contract `pickerReason`). */
export interface ListReason {
  readonly id: string
  readonly list: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
  readonly needsDetail: boolean
  readonly sortOrder: number
}

export function fromListReason(reason: ListReason): PickerReason {
  return { id: reason.code, list: reason.list, code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn, labelI18n: reason.labelI18n, icon: reason.icon, colour: reason.colour, photo: null, needsDetail: reason.needsDetail, sortOrder: reason.sortOrder }
}

/** A scrap or rework reason as the bundle card carries it (ScrapReason: words only, no icon, colour or other language yet). */
export interface ScanReason {
  readonly kind: 'SCRAP' | 'REWORK'
  readonly code: string
  readonly label: { readonly it: string; readonly en: string }
  readonly sortOrder: number
}

export function fromScanReason(reason: ScanReason): PickerReason {
  return { id: reason.code, list: reason.kind, code: reason.code, labelIt: reason.label.it, labelEn: reason.label.en, labelI18n: {}, icon: null, colour: null, photo: null, needsDetail: false, sortOrder: reason.sortOrder }
}

/**
 * A reason a screen fixes itself (B-W2a-75's split: REWORK, RECUT, HOLD, codes the API takes as they are): its word and
 * hint come from the screen's catalogue, already in the worker's language, so the word stands for every language.
 */
export interface FixedReason {
  /** A name of the screen's own list (SPLIT): the standard look is kept per list and code. */
  readonly list: string
  readonly code: string
  readonly label: string
  readonly hint?: string | null
  readonly sortOrder: number
}

export function fromFixedReason(reason: FixedReason): PickerReason {
  return { id: reason.code, list: reason.list, code: reason.code, labelIt: reason.label, labelEn: reason.label, labelI18n: {}, icon: null, colour: null, photo: null, needsDetail: false, sortOrder: reason.sortOrder, hint: reason.hint ?? null }
}

/** A defect as `GET /quality/defects/picker` answers it (B-W2a-26); its picture's address comes from the host. */
export interface DefectReason {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
  readonly pictureFileId: string | null
  readonly needsDetail: boolean
  readonly sortOrder: number
}

export function fromDefect(defect: DefectReason, photoOf: (fileId: string) => string | null = () => null): PickerReason {
  return {
    id: defect.code,
    list: 'DEFECT',
    code: defect.code,
    labelIt: defect.labelIt,
    labelEn: defect.labelEn,
    labelI18n: defect.labelI18n,
    icon: defect.icon,
    colour: defect.colour,
    photo: defect.pictureFileId ? photoOf(defect.pictureFileId) : null,
    needsDetail: defect.needsDetail,
    sortOrder: defect.sortOrder,
  }
}

/** The reasons in tile order (the office's order; the code breaks a tie). Never per person (no learning, design). */
export function inTileOrder(reasons: readonly PickerReason[]): PickerReason[] {
  return [...reasons].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
}

/** The reason's word in the worker's language (another floor language falls back to English). */
export function wordOf(reason: PickerReason, language: string): string {
  return reasonLabel(reason, language)
}

// ---- the look: icon and tone -------------------------------------------------------------------------------------

/**
 * The DS swatches (packages/ui tagSwatches = factory-domain REASON_COLOURS) as the grid's tones: the word and the icon
 * carry the meaning, the tone only repeats it, and a tenant hex is never painted (B-W2a-24 "tones only").
 */
const TONE_OF_COLOUR: Readonly<Record<string, ReasonTone>> = {
  '#1f6fde': 'primary',
  '#15a34a': 'success',
  '#059669': 'success',
  '#65a30d': 'success',
  '#b87503': 'warning',
  '#ea580c': 'warning',
  '#e5484d': 'danger',
  '#f43f5e': 'danger',
  '#be185d': 'danger',
  '#c026d3': 'info',
  '#7400bc': 'info',
  '#8b5cf6': 'info',
  '#6366f1': 'info',
  '#0e7490': 'info',
  '#8d6e63': 'neutral',
  '#5b6573': 'neutral',
}

/** The icons a tile may draw: the office's DS tag icon (`tag:<id>`), or a standard look of a scan or fixed code (`std:<name>`). */
export const STANDARD_ICONS = ['flaw', 'scissors', 'stitch', 'stain', 'tear', 'machine', 'ruler', 'zip', 'shield', 'clean', 'scrap', 'rework', 'hand', 'help', 'dot'] as const
export type StandardIcon = (typeof STANDARD_ICONS)[number]
export type IconKey = `tag:${string}` | `std:${StandardIcon}`

/**
 * The scan lists (SCRAP, REWORK) keep no icon or colour yet (ScrapReason: words only, B-W2a-18's schema need): their
 * standard codes (factory-domain production/scans W1_SCAN_REASONS) get a look of their own, a code the office added gets
 * its kind's. Replaced by the office's own icon the day the table keeps one. A screen's fixed codes (SPLIT, factory-domain
 * production/bundles SPLIT_REASONS) have theirs here too.
 */
const SCAN_LOOK: Readonly<Record<string, { icon: StandardIcon; tone: ReasonTone }>> = {
  'SCRAP:LEATHER_FLAW': { icon: 'flaw', tone: 'danger' },
  'SCRAP:CUT_WRONG': { icon: 'scissors', tone: 'danger' },
  'SCRAP:STITCHING': { icon: 'stitch', tone: 'danger' },
  'SCRAP:STAIN': { icon: 'stain', tone: 'warning' },
  'SCRAP:TEAR': { icon: 'tear', tone: 'danger' },
  'SCRAP:MACHINE': { icon: 'machine', tone: 'warning' },
  'SCRAP:OTHER': { icon: 'help', tone: 'neutral' },
  'REWORK:RESTITCH': { icon: 'stitch', tone: 'warning' },
  'REWORK:ALIGNMENT': { icon: 'ruler', tone: 'warning' },
  'REWORK:HARDWARE': { icon: 'zip', tone: 'warning' },
  'REWORK:PROTECTOR': { icon: 'shield', tone: 'info' },
  'REWORK:CLEANING': { icon: 'clean', tone: 'info' },
  'REWORK:OTHER': { icon: 'help', tone: 'neutral' },
  'SPLIT:REWORK': { icon: 'rework', tone: 'warning' },
  'SPLIT:RECUT': { icon: 'scissors', tone: 'info' },
  'SPLIT:HOLD': { icon: 'hand', tone: 'danger' },
}

const KIND_LOOK: Readonly<Record<string, { icon: StandardIcon; tone: ReasonTone }>> = {
  SCRAP: { icon: 'scrap', tone: 'danger' },
  REWORK: { icon: 'rework', tone: 'warning' },
}

export function lookOf(reason: PickerReason): { icon: IconKey; tone: ReasonTone } {
  const tone = reason.colour ? (TONE_OF_COLOUR[reason.colour.toLowerCase()] ?? 'neutral') : null
  if (reason.icon) return { icon: `tag:${reason.icon}`, tone: tone ?? 'neutral' }
  const standard = SCAN_LOOK[`${reason.list}:${reason.code}`] ?? KIND_LOOK[reason.list]
  if (standard) return { icon: `std:${standard.icon}`, tone: tone ?? standard.tone }
  return { icon: reason.code === 'OTHER' ? 'std:help' : 'std:dot', tone: tone ?? 'neutral' }
}

/** A tile as the view draws it (the view turns `icon` into a glyph). */
export interface PickerTile {
  readonly id: string
  readonly label: string
  readonly icon: IconKey
  readonly photo: string | null
  readonly tone: ReasonTone
  /** "Needs a photo": only where the host keeps one (no typing on the floor). */
  readonly photoNeeded: boolean
  /** The second line under the word, or null. */
  readonly hint: string | null
  /** Why this tile cannot be picked here now (in view, never picked), or null. */
  readonly heldReason: string | null
}

export interface TileOptions {
  /** The host takes a photo after Done for a reason that asks for more ("Other"); without it no tile asks for one. */
  readonly withPhotos?: boolean
  /** Why no tile may be picked now (the host's call needs the network), or null. */
  readonly held?: string | null
  /** Why a reason asking for more is held here (a purpose of NOTE_IN_OFFICE, the host keeping no photo), or null. */
  readonly noteHeld?: string | null
}

export function tilesOf(reasons: readonly PickerReason[], language: string, options: TileOptions = {}): PickerTile[] {
  return inTileOrder(reasons).map((reason) => {
    const look = lookOf(reason)
    const photoNeeded = Boolean(options.withPhotos) && reason.needsDetail
    const heldReason = options.held ?? (reason.needsDetail && !photoNeeded ? (options.noteHeld ?? null) : null)
    return { id: reason.id, label: wordOf(reason, language), icon: look.icon, photo: reason.photo, tone: look.tone, photoNeeded, hint: reason.hint ?? null, heldReason }
  })
}

// ---- counting and picking ------------------------------------------------------------------------------------------

/** Pieces counted in all. */
export function countedOf(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, value) => total + (value > 0 ? value : 0), 0)
}

/** Why Done waits (pick mode: nothing picked yet), or null. Count mode never waits: no tap is nothing of that kind. */
export function doneHeld(mode: PickerMode, value: string | null | undefined): 'choose' | null {
  return mode === 'pick' && !value ? 'choose' : null
}

/** The picked reason, when it is still in the list (the office may have set it inactive meanwhile). */
export function pickedOf(reasons: readonly PickerReason[], value: string | null | undefined): PickerReason | null {
  return value ? (reasons.find((reason) => reason.id === value) ?? null) : null
}

/** What the picker's grid shows: the reasons, or why it cannot yet (loading, failed, offline with nothing kept). */
export type PickerState = 'ready' | 'loading' | 'error' | 'offline'

/** An office list as a host hands it to the picker: the reasons, the grid's state, and as of when when this tablet kept them. */
export interface PickerList {
  readonly state: PickerState
  readonly reasons: readonly PickerReason[]
  readonly asOf: string | null
}

/** The list's reasons may be asked: on screen and not empty (a host whose call goes without a reason otherwise). */
export function listOffers(list: PickerList | null | undefined): boolean {
  return list?.state === 'ready' && list.reasons.length > 0
}

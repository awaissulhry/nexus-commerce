import { ANONYMOUS_KINDS, EMERGENCY_NUMBER, INCIDENT_KINDS, INCIDENT_LIMITS, KIND_WORDS, type IncidentKind, type Involvement } from '@nexus/factory-domain/safety/incidents/rules'
import type { Locale } from '../../../lib/i18n/locales'
import type { CallType, HelpStation } from '../help/api'
import { tilePress, type QueuedCall, type TilePress } from '../help/model'

/**
 * Report an incident's rules (B-W2b-137, SCR-230; design floor.incident, QHS-265; on the merged API of B-W2b-125). Pure, so the
 * tests hold them:
 *
 *   someone hurt first   112 (factory-domain EMERGENCY_NUMBER, so it shows with no network and before any read), the site's
 *                        first aiders, and a call for help in one tap (the station's Safety call, else its team leader's)
 *   three taps           What happened? (Incident · Near miss · Hazard) → Where? ("Here: this station" first, this station's
 *                        machines, the site's areas, somewhere else in words) → Send
 *   without a name       a near miss or a hazard only, naming nobody (factory-domain ANONYMOUS_KINDS): sent ONLINE only, never
 *                        kept in the tablet's queue (its ledger names the tablet); held in this page while the network is gone
 *   with the name        saved in the tablet's queue first (`safety.incident.report`), so it is never lost offline
 *   photo and people     optional: a photo ("no faces"), up to 4 within 30 minutes of the report, sent once the office has it;
 *                        the people for an incident (me, another worker of this tablet, someone from outside by name)
 *
 * No money, no injury detail (the office keeps those: GDPR art. 9), never a person's name outside this one report.
 */

export const KINDS: readonly IncidentKind[] = INCIDENT_KINDS
export const EMERGENCY = EMERGENCY_NUMBER
export const QUEUED_KIND = 'safety.incident.report' as const

/** The most photos a tablet adds to its report, and the minutes after the report it may (the office adds more later). */
export const PHOTOS_MAX = INCIDENT_LIMITS.floorPhotos
export const PHOTO_MINUTES = INCIDENT_LIMITS.floorPhotoMinutes
export const PEOPLE_MAX = INCIDENT_LIMITS.people
/** Words typed on the tablet: short (the API takes 2 000; the safety officer asks the rest). */
export const WORDS_MAX = 500
export const PLACE_MAX = 200
export const NAME_MAX = INCIDENT_LIMITS.outsideName

/** The tiles' words are factory-domain's (KIND_WORDS); the catalogue holds the same (a test keeps them equal). */
export const kindWords = (kind: IncidentKind, locale: Locale): string => KIND_WORDS[kind][locale]

// ---- the three steps ------------------------------------------------------------------------------------------------------

export type Stage = 'what' | 'where' | 'details'
export const STAGES: readonly Stage[] = ['what', 'where', 'details']

/** Where it happened: a tile of the Where? step. */
export type WherePick =
  | { readonly kind: 'here' }
  | { readonly kind: 'machine'; readonly id: string; readonly assetNumber: string; /** At this tablet's station: the report says "here" too. */ readonly here: boolean }
  | { readonly kind: 'area'; readonly id: string; readonly code: string; readonly name: string }
  | { readonly kind: 'elsewhere' }

export const whereId = (where: WherePick): string => (where.kind === 'machine' ? `machine:${where.id}` : where.kind === 'area' ? `area:${where.id}` : where.kind)

/** A person named in the report (an incident only): who, and hurt or only there. Their injury is the office's to record. */
export interface PersonDraft {
  /** This page's own id of the row. */
  readonly id: string
  readonly who: 'ME' | 'WORKER' | 'OUTSIDE'
  readonly workerId?: string
  /** The name as the screen shows it in this one report (me: the person signed in). */
  readonly name: string
  readonly involvement: Involvement
}

/** A photo taken on this tablet, not sent yet: in this page's memory only (never the queue: it has no bytes). */
export interface TakenPhoto {
  readonly id: string
  readonly blob: Blob
  readonly name: string
}

export interface IncidentDraft {
  readonly kind: IncidentKind | null
  readonly where: WherePick | null
  /** "Somewhere else": the place in words. */
  readonly place: string
  /** Optional words of what happened (empty: the API writes the tile's words in the screen's language). */
  readonly words: string
  readonly wordsOpen: boolean
  readonly people: readonly PersonDraft[]
  /** "Send without my name" (a near miss or a hazard). */
  readonly withoutName: boolean
  readonly photos: readonly TakenPhoto[]
}

export const EMPTY_DRAFT: IncidentDraft = { kind: null, where: null, place: '', words: '', wordsOpen: false, people: [], withoutName: false, photos: [] }

/** May this kind go without a name (the API's list, or factory-domain's when the tablet has not read it)? */
export const mayGoWithoutName = (kind: IncidentKind | null, anonymousKinds: readonly IncidentKind[] = ANONYMOUS_KINDS): boolean => kind !== null && anonymousKinds.includes(kind)

/** The design: "people involved for an incident". */
export const peopleAsked = (kind: IncidentKind | null): boolean => kind === 'INJURY'

/** The report really goes without a name: asked for, and allowed for its kind. */
export const sendsWithoutName = (draft: Pick<IncidentDraft, 'kind' | 'withoutName'>, anonymousKinds?: readonly IncidentKind[]): boolean => draft.withoutName && mayGoWithoutName(draft.kind, anonymousKinds)

/** A kind picked: a kind that may not go without a name drops the switch; one without people drops the people. */
export function kindPicked(draft: IncidentDraft, kind: IncidentKind, anonymousKinds?: readonly IncidentKind[]): IncidentDraft {
  return { ...draft, kind, withoutName: draft.withoutName && mayGoWithoutName(kind, anonymousKinds), people: peopleAsked(kind) ? draft.people : [] }
}

// ---- where -------------------------------------------------------------------------------------------------------------------

export interface WhereFacts {
  /** This tablet's station (the device's), or null. */
  readonly station: { readonly code: string; readonly name: string } | null
  /** This station's machines (the API's start), or none. */
  readonly machines: readonly { readonly id: string; readonly assetNumber: string }[]
  readonly areas: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  /** A machine the machine report passed on (Guard missing), when it is not one of this station's. */
  readonly offered?: { readonly id: string; readonly assetNumber: string } | null
}

/** The Where? tiles, in the design's order: "Here: this station" first, its machines, the site's areas, somewhere else last. */
export function whereTiles(facts: WhereFacts): WherePick[] {
  const tiles: WherePick[] = []
  if (facts.station) tiles.push({ kind: 'here' })
  const offered = facts.offered && !facts.machines.some((machine) => machine.id === facts.offered!.id) ? facts.offered : null
  if (offered) tiles.push({ kind: 'machine', id: offered.id, assetNumber: offered.assetNumber, here: false })
  for (const machine of facts.machines) tiles.push({ kind: 'machine', id: machine.id, assetNumber: machine.assetNumber, here: facts.station !== null })
  for (const area of facts.areas) tiles.push({ kind: 'area', id: area.id, code: area.code, name: area.name })
  tiles.push({ kind: 'elsewhere' })
  return tiles
}

/** The tile the machine report passed on, picked for the person (they may pick another). */
export function offeredWhere(tiles: readonly WherePick[], machineId: string | null | undefined): WherePick | null {
  if (!machineId) return null
  return tiles.find((tile) => tile.kind === 'machine' && tile.id === machineId) ?? null
}

// ---- people ------------------------------------------------------------------------------------------------------------------

/** Why a person cannot be added now (a `floor-incident` key), or null. */
export function personHeld(draft: Pick<IncidentDraft, 'people'>, who: PersonDraft['who'], facts: { readonly meId: string; readonly roster: number }): string | null {
  if (draft.people.length >= PEOPLE_MAX) return 'held.peopleFull'
  if (who === 'ME' && draft.people.some((person) => person.who === 'ME' || person.workerId === facts.meId)) return 'held.meAdded'
  if (who === 'WORKER' && facts.roster === 0) return 'held.noRoster'
  return null
}

/** Another worker picked by name: never twice, never the person signed in (that is "Me"). */
export function workerHeld(draft: Pick<IncidentDraft, 'people'>, workerId: string, meId: string): string | null {
  if (workerId === meId) return 'held.thatIsMe'
  return draft.people.some((person) => person.workerId === workerId) ? 'held.personAdded' : null
}

/** Someone from outside: a name, at most NAME_MAX characters. */
export const outsideHeld = (name: string): string | null => (name.trim() === '' ? 'held.outsideName' : null)

// ---- sending -----------------------------------------------------------------------------------------------------------------

/** Why Send cannot go now (a `floor-incident` key), or null. Offline is no reason: with the name it saves on this tablet. */
export function sendHeld(draft: IncidentDraft, busy = false): string | null {
  if (!draft.kind) return 'held.kind'
  if (!draft.where) return 'held.where'
  if (draft.where.kind === 'elsewhere' && draft.place.trim() === '') return 'held.place'
  if (busy) return 'held.busy'
  return null
}

export interface FloorPersonBody {
  readonly who: 'ME' | 'WORKER' | 'OUTSIDE'
  readonly workerId?: string
  readonly outsideName?: string
  readonly involvement: Involvement
}

/** POST /safety/floor/incidents's body (and the queued kind's payload): only what the person said. */
export interface ReportBody {
  readonly kind: IncidentKind
  readonly language: Locale
  readonly occurredAt?: string
  readonly what?: string
  readonly here?: boolean
  readonly areaId?: string
  readonly machineId?: string
  readonly place?: string
  readonly anonymous?: true
  readonly people?: readonly FloorPersonBody[]
}

const whereBody = (where: WherePick, place: string): Pick<ReportBody, 'here' | 'areaId' | 'machineId' | 'place'> => {
  switch (where.kind) {
    case 'here':
      return { here: true }
    case 'machine':
      return { machineId: where.id, ...(where.here ? { here: true } : {}) }
    case 'area':
      return { areaId: where.id }
    case 'elsewhere':
      return { place: place.trim().slice(0, PLACE_MAX) }
  }
}

/**
 * The body of a complete draft (sendHeld null). Without a name: no people, ever (the API refuses one that names anybody).
 * `occurredAt`: only for the report sent online (the queue's own envelope carries the tap's time for a saved one, and two
 * times for one report would make its retry a different request).
 */
export function reportBody(draft: IncidentDraft, locale: Locale, options: { readonly anonymousKinds?: readonly IncidentKind[]; readonly occurredAt?: string } = {}): ReportBody {
  const anonymous = sendsWithoutName(draft, options.anonymousKinds)
  const words = draft.words.trim().slice(0, WORDS_MAX)
  const people = anonymous || !peopleAsked(draft.kind) ? [] : draft.people
  return {
    kind: draft.kind!,
    language: locale,
    ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
    ...(words ? { what: words } : {}),
    ...whereBody(draft.where!, draft.place),
    ...(anonymous ? { anonymous: true as const } : {}),
    ...(people.length > 0
      ? {
          people: people.map((person) => ({
            who: person.who,
            ...(person.who === 'WORKER' && person.workerId ? { workerId: person.workerId } : {}),
            ...(person.who === 'OUTSIDE' ? { outsideName: person.name.trim().slice(0, NAME_MAX) } : {}),
            involvement: person.involvement,
          })),
        }
      : {}),
  }
}

/** The queued kind's payload: the body without its time (the queue's envelope gives the tap's time). */
export const queuedPayload = (body: ReportBody): Record<string, unknown> => {
  const { occurredAt: _ignored, ...rest } = body
  return { ...rest }
}

// ---- after Send ---------------------------------------------------------------------------------------------------------------

/** Where a photo taken with the report stands, once the office has the report. */
export type UploadState = 'waiting' | 'sending' | 'added' | 'failed'

export interface PhotoUpload {
  readonly id: string
  readonly name: string
  readonly state: UploadState
  /** The office's refusal: a code this screen has words for (PHOTOS_FULL, PHOTO_WINDOW, NOT_OPEN), else the API's words; or null. */
  readonly refusal?: string | null
}

/** The next one to send: the first still waiting (one at a time, in the order they were taken). */
export const nextUpload = (uploads: readonly PhotoUpload[]): PhotoUpload | null => (uploads.some((entry) => entry.state === 'sending') ? null : (uploads.find((entry) => entry.state === 'waiting') ?? null))

/** The file's name as the office sees it: the report's number (or "report") and its place in the list. Never a person. */
export const photoName = (number: string | null, index: number): string => `${number ?? 'incident'}-photo-${index}.jpg`

/**
 * Why the tablet takes no photo now (a `floor-incident` key), or null: a photo needs the network, four at most, and once the
 * report is in, only within 30 minutes of it (`since`: when the office's answer named it).
 */
export function photoHeld(input: { readonly online: boolean; readonly count: number; readonly since?: string | null; readonly now?: Date; readonly busy?: boolean }): string | null {
  if (!input.online) return 'held.photoOffline'
  if (input.count >= PHOTOS_MAX) return 'held.photosFull'
  if (input.since && (input.now ?? new Date()).getTime() - new Date(input.since).getTime() > PHOTO_MINUTES * 60_000) return 'held.photoWindow'
  if (input.busy) return 'held.busy'
  return null
}

// ---- the call for help ------------------------------------------------------------------------------------------------------

/**
 * The call the emergency's button sends in one tap: this station's Safety call (design conn "Call for help (Safety)"), else
 * its team leader's; null: no such call here (the button opens Call for help instead).
 */
export function helpCallOf(station: Pick<HelpStation, 'station' | 'tiles'> | null): CallType | null {
  if (!station?.station) return null
  const types = station.tiles.map((tile) => tile.type)
  return types.find((type) => type.code === 'SAFETY') ?? types.find((type) => type.kind === 'SUPERVISOR') ?? null
}

/** What the one tap does: shows the station's open call of that type, the one still on this tablet, or sends (help/model). */
export function helpPress(station: HelpStation, type: CallType, queued: readonly QueuedCall[]): TilePress {
  const tile = station.tiles.find((entry) => entry.type.id === type.id) ?? { type, open: null }
  return tilePress(tile, queued)
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** The API's refusals this screen has its own words for (`refusal.<CODE>`); any other shows the API's words. */
export const KNOWN_REFUSALS = [
  'ANONYMOUS_INJURY',
  'ANONYMOUS_NAMES_NOBODY',
  'ANONYMOUS_NOT_QUEUED',
  'WHERE_MISSING',
  'WHERE_OTHER_SITE',
  'OCCURRED_IN_FUTURE',
  'INJURED_NOT_INJURY',
  'PERSON_TWICE',
  'PHOTOS_FULL',
  'PHOTO_WINDOW',
  'NOT_OPEN',
] as const
export const isKnownRefusal = (code: string): boolean => (KNOWN_REFUSALS as readonly string[]).includes(code)

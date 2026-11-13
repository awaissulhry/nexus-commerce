import { BLOCK_NOTE_MAX } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { LOCATION_KIND_PROFILES } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { LABEL_CODE, normalizeLabelCode, suggestedLabelCode } from '@nexus/factory-domain/inventory/locations-depth/labels'
import type { LabelLayout, LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { LocationKind, LocationView, PrinterOption } from '../../../_shared/stock/api'
import type { Phrase } from '../../../_shared/stock/model'
import type { BlockReason, DefaultView, LabelJob, PartyChoice, PlaceLabel, PlaceView, PrintAnswer, Purpose } from './api'

/**
 * Locations in depth (B-W2b-327 on B-W2b-289's API; design warehouse.locations: Status Active / Blocked / Archived, Default
 * for, Label, row ⋯ Block, Print labels, the bin labels PDF, Location › Labels, the W2b kinds; a count blocks its places),
 * pure: a place's status and its block in words, who may block or unblock it and why not, the Block dialog's checks, what
 * each place is the default for, which places can carry a bin label, the Print labels dialog, a place's label code, the
 * kinds' profiles (what a place holds; at the top of the tree; nothing inside) and the new place's party. Words are keys of
 * `warehouse-depth` (`wd.loc.`).
 */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

// ---- status and block --------------------------------------------------------------------------------------------------------

export type PlaceStatus = 'ACTIVE' | 'BLOCKED' | 'ARCHIVED'
export const STATUS_TONE: Readonly<Record<PlaceStatus, 'success' | 'danger' | 'neutral'>> = { ACTIVE: 'success', BLOCKED: 'danger', ARCHIVED: 'neutral' }

/** Active, Blocked (a block that still holds) or Archived. */
export function placeStatus(place: Pick<PlaceView, 'status' | 'block'>): PlaceStatus {
  if (place.status === 'ARCHIVED') return 'ARCHIVED'
  return place.block?.holds ? 'BLOCKED' : 'ACTIVE'
}

/** A count's block (its counting holds the place): the count lifts it, nobody else. */
export const countsBlock = (place: Pick<PlaceView, 'block'>): boolean => !!place.block?.holds && !!place.block.countNumber

/** The Counts list searched for the count that blocks a place (the block names its number). */
export const countHref = (prefix: string, countNumber: string) => `${prefix}/warehouse/counts?${new URLSearchParams({ q: countNumber }).toString()}`

export interface DepthCan {
  manage: boolean
  /** print.labels and print.view: a label printer job. */
  printLabels: boolean
  /** print.view: the site's printers (and a label's print history). */
  printView: boolean
  /** parties.view: the party a workshop's or a customer's place names. */
  parties: boolean
}
export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return { manage: held.has('inventory.locations.manage'), printLabels: held.has('print.labels') && held.has('print.view'), printView: held.has('print.view'), parties: held.has('parties.view') }
}

/** Why Block… (or Change block…) is held (a key of warehouse-depth with its values), or null. */
export function blockHeldOf(place: Pick<PlaceView, 'status' | 'kind' | 'block' | 'code'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return { key: 'wd.loc.held.noManage' }
  if (place.status === 'ARCHIVED') return { key: 'wd.loc.held.archived' }
  if (!LOCATION_KIND_PROFILES[place.kind].blockable) return { key: 'wd.loc.held.notBlockable' }
  if (countsBlock(place)) return { key: 'wd.loc.held.countBlock', params: { number: place.block!.countNumber! } }
  return null
}

/** Why Unblock is held, or null. */
export function unblockHeldOf(place: Pick<PlaceView, 'block'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return { key: 'wd.loc.held.noManage' }
  if (!place.block) return { key: 'wd.loc.held.notBlocked' }
  if (countsBlock(place)) return { key: 'wd.loc.held.countBlock', params: { number: place.block.countNumber! } }
  return null
}

export interface BlockDraft {
  reason: BlockReason | ''
  note: string
  /** The last day it holds (YYYY-MM-DD); '' = until unblocked. */
  until: string
}
export const blockDraftOf = (place: Pick<PlaceView, 'block'>): BlockDraft =>
  place.block && place.block.holds && !place.block.countNumber ? { reason: place.block.reason, note: place.block.note ?? '', until: place.block.until ?? '' } : { reason: '', note: '', until: '' }

/** What still holds Block (the first names the held button's reason): a reason, words for Other, an until-day not past. */
export function blockChecks(draft: BlockDraft, today: string): string[] {
  const checks: string[] = []
  if (!draft.reason) checks.push('wd.loc.block.held.reason')
  if (draft.reason === 'OTHER' && !draft.note.trim()) checks.push('wd.loc.block.held.note')
  if (draft.note.trim().length > BLOCK_NOTE_MAX) checks.push('wd.loc.block.held.long')
  if (draft.until && draft.until < today) checks.push('wd.loc.block.held.past')
  return checks
}

/** A refused block or unblock in our words. */
export function blockProblemOf(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'wd.loc.problem.write' }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') return { key: 'wd.loc.problem.changed' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('location'))) return { key: 'wd.loc.problem.notNow' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('until'))) return { key: 'wd.loc.block.held.past' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('note'))) return { key: 'wd.loc.block.held.note' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'wd.loc.problem.forbidden' }
  if (error.kind === 'not_found') return { key: 'wd.loc.problem.gone' }
  if (error.kind === 'unavailable') return { key: 'wd.loc.problem.offline' }
  return { key: 'wd.loc.problem.write' }
}

// ---- what a place is the default for --------------------------------------------------------------------------------------

export interface PlaceDefault {
  purpose: Purpose
  /** null: every kind of material without its own default (the site's fallback). */
  itemKind: DefaultView['itemKind']
}
/** The defaults that name this place, purpose by purpose. */
export function defaultsOf(placeId: string, defaults: readonly DefaultView[] | null | undefined): PlaceDefault[] {
  return (defaults ?? []).filter((entry) => entry.location.id === placeId).map((entry) => ({ purpose: entry.purpose, itemKind: entry.itemKind }))
}

// ---- kinds ------------------------------------------------------------------------------------------------------------------------

/** The words of a kind's profile: what it holds, its group, at the top of the tree, nothing inside, no label, no block. */
export function kindFacts(kind: LocationKind): string[] {
  const profile = LOCATION_KIND_PROFILES[kind]
  const facts = [`wd.loc.holds.${profile.holds}`, `wd.loc.group.${profile.group}`]
  if (profile.atTop) facts.push('wd.loc.kind.atTop')
  if (!profile.container) facts.push('wd.loc.kind.noInside')
  if (!profile.labelled) facts.push('wd.loc.kind.noLabel')
  if (profile.transferOnly) facts.push('wd.loc.kind.transferOnly')
  if (profile.party) facts.push(profile.party.includes('CUSTOMER') ? 'wd.loc.kind.namesCustomer' : 'wd.loc.kind.namesWorkshop')
  return facts
}

/** The party roles a new place of this kind names (a workshop's; a customer's or brand's), or null. */
export const partyRolesOf = (kind: LocationKind): readonly string[] | null => LOCATION_KIND_PROFILES[kind].party

/** Why a new place of `kind` under `parent` is refused before it is sent (a key of warehouse-depth), or null. */
export function placementHeldOf(kind: LocationKind, parent: Pick<LocationView, 'kind' | 'code'> | null): Phrase | null {
  if (parent !== null && LOCATION_KIND_PROFILES[kind].atTop) return { key: 'wd.loc.new.atTop' }
  if (parent !== null && !LOCATION_KIND_PROFILES[parent.kind].container) return { key: 'wd.loc.new.noInside', params: { code: parent.code } }
  return null
}

/** Why a new place's party is missing (its kind names one), or null. */
export function partyHeldOf(kind: LocationKind, partyId: string | null | undefined, parties: Loaded<PartyChoice[]> | null | undefined, can: Pick<DepthCan, 'parties'>): Phrase | null {
  if (!partyRolesOf(kind)) return null
  if (!can.parties) return { key: 'wd.loc.new.partyNoRight' }
  if (parties?.status === 'ready' && parties.value.length === 0) return { key: LOCATION_KIND_PROFILES[kind].party?.includes('CUSTOMER') ? 'wd.loc.new.noCustomers' : 'wd.loc.new.noWorkshops' }
  if (!partyId) return { key: 'wd.loc.new.partyPick' }
  return null
}

/** The kinds a place may turn into (an outside or transit place stays one; nothing turns into one; a pick face holds no places). */
export function retypeKinds(current: LocationKind, children: number, hasParent: boolean): { kind: LocationKind; held: boolean }[] {
  return (Object.keys(LOCATION_KIND_PROFILES) as LocationKind[]).map((kind) => {
    if (kind === current) return { kind, held: false }
    const before = LOCATION_KIND_PROFILES[current]
    const after = LOCATION_KIND_PROFILES[kind]
    return { kind, held: before.fixed || after.fixed || (children > 0 && !after.container) || (hasParent && after.atTop) }
  })
}

/** A fixed kind never changes (its party or its transfers depend on it). */
export const kindFixed = (kind: LocationKind): boolean => LOCATION_KIND_PROFILES[kind].fixed

// ---- bin labels -------------------------------------------------------------------------------------------------------------

/** Why a place cannot carry a bin label (a key of warehouse-depth), or null: an outside or transit place, an archived one. */
export function labelRefusalOf(place: Pick<PlaceView, 'kind' | 'status'>): string | null {
  if (place.status === 'ARCHIVED') return 'wd.loc.label.refused.archived'
  if (!LOCATION_KIND_PROFILES[place.kind].labelled) return 'wd.loc.label.refused.kind'
  return null
}

/** The code a place's label carries: its own, or the one it gets (`<site>-<code>`). */
export const labelCodeOf = (place: Pick<PlaceView, 'labelCode' | 'code'>, siteCode: string): { code: string; suggested: boolean } =>
  place.labelCode ? { code: place.labelCode, suggested: false } : { code: suggestedLabelCode(siteCode, place.code), suggested: true }

/** A typed label code's problem (a key of warehouse-depth), or null. */
export function labelCodeProblem(typed: string, others: readonly Pick<PlaceView, 'id' | 'labelCode'>[], placeId: string): string | null {
  const code = normalizeLabelCode(typed)
  if (!code) return 'wd.loc.label.code.missing'
  if (!LABEL_CODE.test(code)) return 'wd.loc.label.code.shape'
  if (others.some((other) => other.id !== placeId && other.labelCode === code)) return 'wd.loc.label.code.taken'
  return null
}

/** A refused label code in our words: another place carries it (409), its shape, the version. */
export function labelCodeWriteProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'wd.loc.problem.write' }
  if (error.kind === 'conflict' && /carr|already|another/i.test(error.message)) return { key: 'wd.loc.label.code.taken' }
  if (error.kind === 'conflict') return { key: 'wd.loc.problem.changed' }
  if (error.kind === 'invalid') return { key: 'wd.loc.label.code.shape' }
  return blockProblemOf(error)
}

export interface PrintDraft {
  /** A label printer's id, or PDF (printed from the browser). */
  printerId: string | 'PDF'
  copies: number
  language: 'it' | 'en'
}

export interface PrintDialogModel {
  /** The places picked (any site of the company: a printer prints its own site's). */
  places: PlaceView[]
  siteCode: string
  draft: PrintDraft
  /** The site's label printers (print.view), or null while read. */
  printers: Loaded<PrinterOption[]> | null
  posting: boolean
  problem: Phrase | null
  /**
   * After a print: the jobs queued, and the places refused (in words). B-W2b-383: after the PDF, `pdfLeftOut` = how many
   * places the API gave no label (its `x-labels-refused`): only then does the dialog stay open.
   */
  done?: { jobs: PrintAnswer['jobs']; refused: { code: string; key: string }[]; pdfLeftOut?: number } | null
}

export interface PrintActions {
  onChange?: (draft: PrintDraft) => void
  onPrint?: () => void
  onClose?: () => void
}

/** The places of a print that will carry a label, those that get their suggested code first, and those refused. */
export function printSplit(places: readonly PlaceView[]): { printable: PlaceView[]; needCode: PlaceView[]; refused: { place: PlaceView; key: string }[] } {
  const printable: PlaceView[] = []
  const refused: { place: PlaceView; key: string }[] = []
  for (const place of places) {
    const key = labelRefusalOf(place)
    if (key) refused.push({ place, key })
    else printable.push(place)
  }
  return { printable, needCode: printable.filter((place) => !place.labelCode), refused }
}

/** Why Print (or the PDF) is held (a key of warehouse-depth with its values), or null. */
export function printHeldOf(model: Pick<PrintDialogModel, 'places' | 'draft' | 'posting' | 'printers'>, can: Pick<DepthCan, 'printLabels' | 'manage'>): Phrase | null {
  if (model.posting) return { key: 'wd.loc.print.posting' }
  const split = printSplit(model.places)
  if (split.printable.length === 0) return { key: 'wd.loc.print.held.none' }
  if (model.places.length > 200) return { key: 'wd.loc.print.held.tooMany' }
  if (model.draft.copies < 1 || model.draft.copies > 10) return { key: 'wd.loc.print.held.copies' }
  if (model.draft.printerId === 'PDF') return null
  if (!can.printLabels) return { key: 'wd.loc.print.held.noRight' }
  // The API gives a place without a code its suggested one only for a person who manages places.
  if (split.needCode.length > 0 && !can.manage) return { key: 'wd.loc.print.held.needCode', params: { count: split.needCode.length } }
  if (!model.draft.printerId) return { key: 'wd.loc.print.held.printer' }
  return null
}

/** Why the band's Print labels is held: nothing selected (the selection is what prints), else null. */
export const printStartHeldKey = (selected: number): string | null => (selected === 0 ? 'wd.loc.print.held.select' : null)

/** A print job's state as the DS LabelPreview draws it. */
export function printStateOf(job: Pick<LabelJob, 'state'>, words: { state: string; detail?: string }): LabelPrintState {
  const status = job.state === 'QUEUED' ? 'queued' : job.state === 'SENT' ? 'sent' : job.state === 'PRINTED' ? 'printed' : 'failed'
  return { status, label: words.state, ...(words.detail ? { detail: words.detail } : {}) }
}

/** The bin label as the DS LabelPreview lays it out (100 × 50 mm): heading, title, the code as bars and text, the facts. */
export function binLabelLayout(label: PlaceLabel['label'], name: string): LabelLayout {
  return {
    name,
    widthMm: 100,
    heightMm: 50,
    blocks: [
      { kind: 'text', text: label.heading, size: 'sm' },
      { kind: 'title', text: label.title, size: 'md' },
      { kind: 'barcode', value: label.scanId, heightMm: 9 },
      { kind: 'fields', columns: 2, fields: label.fields.slice(0, 4).map((field) => ({ label: field.label, value: field.value, size: 'sm' as const })) },
    ],
  }
}

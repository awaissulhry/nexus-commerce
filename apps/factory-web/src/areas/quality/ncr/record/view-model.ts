import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { StepUpState } from '../../_shared/hooks'
import type { LiveState } from '../../_shared/model'
import type {
  CarryOutBody,
  ClaimChoice,
  ContainmentKind,
  Decision,
  DefectChoice,
  DispositionChoice,
  FoundAt,
  HoldSubjectType,
  NcrContent,
  NcrLink,
  NcrPhoto,
  NcrRecord,
  OperationChoice,
  Person,
  ReasonChoice,
  RepairChoice,
  SearchHit,
  Severity,
  SiteChoice,
  StockPlace,
  Uom,
} from '../api'
import { instantOf, localOf, type NcrCan, type RecordTab, type Say } from '../model'
import type { NcrNotice } from '../parts'
import type { CloseDialogModel } from '../view/CloseNcrDialog'

/**
 * The NCR record's view model (SCR-145; `?tab=problem|containment|disposition|linked|activity`) and its pure rules: the
 * Problem tab's draft ⇄ the PATCH body, the containment and decision dialogs' drafts and the bodies they send, what a
 * carry-out needs per disposition code (and the held SCRAP of garments still in work, B-W2a-47 gap), the linked records
 * in groups, a record's address. No React, no API client.
 */

export const TIME_ZONE = 'Europe/Rome'
export const ZONES = GARMENT_ZONES.map((zone) => zone.id)

/** A read of something a dialog picks from: null items = still reading. */
export interface Choices<T> {
  readonly items: readonly T[] | null
  readonly problem: string | null
}
export const choicesReading = <T>(): Choices<T> => ({ items: null, problem: null })
export const choicesOf = <T>(items: readonly T[]): Choices<T> => ({ items, problem: null })

export type Loaded = { status: 'loading' } | { status: 'ready'; record: NcrRecord } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

export type CellState = { state: 'saving' } | { state: 'saved' } | { state: 'failed' }

// ---- the Problem tab ----------------------------------------------------------------------------------------------------

/** The Problem tab's fields as typed (times in the site's zone, `datetime-local`). */
export interface ProblemDraft {
  readonly title: string
  readonly description: string
  readonly quantityAffected: string
  readonly quantitySuspect: string
  readonly uom: Uom
  readonly severity: Severity
  readonly defectCodeId: string
  readonly zone: string
  readonly foundAt: FoundAt
  readonly foundOn: string
  readonly ownerId: string
  readonly containmentDueAt: string
}

export function draftOf(ncr: NcrRecord['ncr'], timeZone = TIME_ZONE): ProblemDraft {
  return {
    title: ncr.title,
    description: ncr.description ?? '',
    quantityAffected: plainQuantity(ncr.quantityAffected),
    quantitySuspect: ncr.quantitySuspect === null ? '' : plainQuantity(ncr.quantitySuspect),
    uom: ncr.uom,
    severity: ncr.severity,
    defectCodeId: ncr.defect?.id ?? '',
    zone: ncr.zone ?? '',
    foundAt: ncr.foundAt,
    foundOn: localOf(ncr.foundOn, timeZone),
    ownerId: ncr.ownerId ?? '',
    containmentDueAt: localOf(ncr.containmentDueAt, timeZone),
  }
}

/** "40.0000" → "40", "51.8000" → "51.8" (what the person typed). */
export function plainQuantity(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

const QUANTITY = /^\d{1,14}([.,]\d{1,4})?$/
export const quantityValue = (value: string): string => value.trim().replace(',', '.')
export const isQuantity = (value: string, positive = true): boolean => QUANTITY.test(value.trim()) && (!positive || Number(quantityValue(value)) > 0)

/** What changed between the saved NCR and the draft: the PATCH body's fields (empty = nothing to save). */
export function changesOf(ncr: NcrRecord['ncr'], draft: ProblemDraft, timeZone = TIME_ZONE): NcrContent {
  const saved = draftOf(ncr, timeZone)
  const body: NcrContent = {}
  if (draft.title.trim() !== saved.title) body.title = draft.title.trim()
  if (draft.description.trim() !== saved.description.trim()) body.description = draft.description.trim() || null
  if (quantityValue(draft.quantityAffected) !== saved.quantityAffected) body.quantityAffected = quantityValue(draft.quantityAffected)
  if (quantityValue(draft.quantitySuspect) !== saved.quantitySuspect) body.quantitySuspect = draft.quantitySuspect.trim() ? quantityValue(draft.quantitySuspect) : null
  if (draft.uom !== saved.uom) body.uom = draft.uom
  if (draft.severity !== saved.severity) body.severity = draft.severity
  if (draft.defectCodeId !== saved.defectCodeId) body.defectCodeId = draft.defectCodeId || null
  if (draft.zone !== saved.zone) body.zone = draft.zone || null
  if (draft.foundAt !== saved.foundAt) body.foundAt = draft.foundAt
  if (draft.foundOn !== saved.foundOn) {
    const instant = instantOf(draft.foundOn, timeZone)
    if (instant) body.foundOn = instant
  }
  if (draft.ownerId !== saved.ownerId) body.ownerId = draft.ownerId || null
  if (draft.containmentDueAt !== saved.containmentDueAt) body.containmentDueAt = instantOf(draft.containmentDueAt, timeZone)
  return body
}

/** Why the draft cannot be saved yet (null: it can), as an `ncr-record` key. */
export function draftHeld(draft: ProblemDraft): string | null {
  if (!draft.title.trim()) return 'problem.heldTitle'
  if (draft.title.trim().length > 160) return 'problem.heldTitleLong'
  if (!isQuantity(draft.quantityAffected)) return 'problem.heldQuantity'
  if (draft.quantitySuspect.trim() && !isQuantity(draft.quantitySuspect, false)) return 'problem.heldSuspect'
  return null
}

// ---- containment --------------------------------------------------------------------------------------------------------

/** "Hold stock": the Place hold dialog's fields (composed here until B-W2a-67's dialog is shared). */
export interface HoldDraft {
  readonly subject: string
  readonly reasonCode: string
  readonly note: string
}

export interface HoldSubject {
  readonly key: string
  readonly subjectType: HoldSubjectType
  readonly id: string
  readonly label: string
}

/** What a hold placed from this NCR may hold: its lot, its work order (more by the Holds page). */
export function holdSubjects(ncr: NcrRecord['ncr']): HoldSubject[] {
  const subjects: HoldSubject[] = []
  if (ncr.lot) subjects.push({ key: `Lot:${ncr.lot.id}`, subjectType: 'Lot', id: ncr.lot.id, label: ncr.lot.code })
  if (ncr.workOrder) subjects.push({ key: `WorkOrder:${ncr.workOrder.id}`, subjectType: 'WorkOrder', id: ncr.workOrder.id, label: ncr.workOrder.number })
  return subjects
}

export const EMPTY_HOLD: HoldDraft = { subject: '', reasonCode: '', note: '' }

export function holdBodyOf(draft: HoldDraft, subjects: readonly HoldSubject[], reasons: readonly ReasonChoice[] | null) {
  const subject = subjects.find((entry) => entry.key === draft.subject)
  if (!subject || !draft.reasonCode) return null
  const reason = reasons?.find((entry) => entry.code === draft.reasonCode)
  if (reason?.needsDetail && !draft.note.trim()) return null
  return { subjectType: subject.subjectType, subjectIds: [subject.id], reasonCode: draft.reasonCode, reasonNote: draft.note.trim() || null }
}

/** Why a hold cannot be placed yet (an `ncr-record` key), or null. */
export function holdHeld(draft: HoldDraft, subjects: readonly HoldSubject[], reasons: readonly ReasonChoice[] | null): string | null {
  if (subjects.length === 0) return 'hold.heldNoSubject'
  if (!draft.subject) return 'hold.heldSubject'
  if (!draft.reasonCode) return 'hold.heldReason'
  if (reasons?.find((entry) => entry.code === draft.reasonCode)?.needsDetail && !draft.note.trim()) return 'hold.heldNote'
  return null
}

export interface ActionDraft {
  readonly kind: ContainmentKind
  readonly description: string
  readonly ownerId: string
  readonly dueAt: string
  /** HOLD_STOCK: place the hold now (the action is done with it). */
  readonly placeHold: boolean
  readonly hold: HoldDraft
}

export const NEW_ACTION: ActionDraft = { kind: 'CHECK_WIP', description: '', ownerId: '', dueAt: '', placeHold: true, hold: EMPTY_HOLD }

// ---- decisions ----------------------------------------------------------------------------------------------------------

export interface DecideDraft {
  readonly dispositionCodeId: string
  readonly quantity: string
  readonly note: string
}

/** One line of a carry-out's stock move: one place where the NCR's goods lie. */
export interface StockLineDraft {
  readonly key: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly fromLocationId: string
  readonly place: string
  readonly what: string
  readonly onHand: string
  readonly quantity: string
  readonly uom: Uom
}

export interface CarryDraft {
  readonly lines: readonly StockLineDraft[]
  readonly toLocationId: string
  /** A repair or a supplier claim named (REPAIR_ORDER, SUPPLIER_CLAIM). */
  readonly followUpId: string
  readonly claimMode: 'open' | 'name'
  readonly claimKind: 'RETURN' | 'CLAIM'
  readonly claimReason: string
  readonly claimNote: string
  readonly claimRemedy: '' | 'CREDIT' | 'REPLACEMENT'
  readonly repairQuery: string
  readonly note: string
}

export const EMPTY_CARRY: CarryDraft = { lines: [], toLocationId: '', followUpId: '', claimMode: 'open', claimKind: 'RETURN', claimReason: '', claimNote: '', claimRemedy: '', repairQuery: '', note: '' }

/** The carry-out's lines from where the goods lie: the decision's quantity taken place by place, as far as each holds. */
export function stockLinesOf(places: readonly StockPlace[], quantity: string): StockLineDraft[] {
  let left = Number(quantity)
  return places
    .filter((place) => Number(place.onHand) > 0)
    .map((place) => {
      const take = Math.max(0, Math.min(left, Number(place.onHand)))
      left -= take
      return {
        key: `${place.location.id}:${place.item.id}:${place.colour?.id ?? ''}:${place.lot?.id ?? ''}:${place.hide?.id ?? ''}`,
        itemId: place.item.id,
        itemColourId: place.colour?.id ?? null,
        lotId: place.lot?.id ?? null,
        hideId: place.hide?.id ?? null,
        fromLocationId: place.location.id,
        place: place.location.code,
        what: [place.item.code, place.colour?.code, place.lot?.code, place.hide?.code].filter(Boolean).join(' · '),
        onHand: place.onHand,
        quantity: take > 0 ? String(Math.round(take * 10000) / 10000) : '',
        uom: place.item.baseUom ?? 'PCS',
      }
    })
}

/** How a decision is carried out, by its code. */
export type CarryKind = 'stock' | 'repair' | 'claim' | 'stockAndClaim' | 'rework' | 'none'

export const carryKindOf = (decision: Pick<Decision, 'disposition'>): CarryKind => codeKindOf(decision.disposition)

/** How a decision with this code is carried out. */
export function codeKindOf(code: Pick<DispositionChoice, 'stockMoveReason' | 'followUp'> | null): CarryKind {
  const move = code?.stockMoveReason ?? null
  const followUp = code?.followUp ?? null
  if (followUp === 'REWORK_ORDER') return 'rework'
  if (followUp === 'REPAIR_ORDER') return 'repair'
  if (followUp === 'SUPPLIER_CLAIM') return move ? 'stockAndClaim' : 'claim'
  if (move) return 'stock'
  return 'none'
}

/**
 * Why this decision's carry-out cannot be offered at all for this NCR (an `ncr-record` key), before the dialog: the
 * SCRAP of garments still in work (no stock to move: B-W2a-47 gap #973, never a fake success), no goods in stock named
 * for another move, no work order for a rework or an issue, no supplier for a claim.
 */
export function carryGap(decision: Decision, ncr: NcrRecord['ncr']): string | null {
  const move = decision.disposition?.stockMoveReason ?? null
  const kind = carryKindOf(decision)
  const stockNamed = ncr.lot !== null || ncr.item !== null
  if (move === 'SCRAP' && !stockNamed) return 'carry.gapGarmentScrap'
  if (move && !stockNamed) return 'carry.gapNoStock'
  if ((kind === 'rework' || move === 'ISSUE') && !ncr.workOrder) return 'carry.gapNoWorkOrder'
  if ((kind === 'claim' || kind === 'stockAndClaim') && !ncr.supplier) return 'carry.gapNoSupplier'
  return null
}

/** The carry-out body from the draft, or null when something it needs is missing. */
export function carryBodyOf(decision: Decision, ncr: NcrRecord['ncr'], draft: CarryDraft): Omit<CarryOutBody, 'version'> | null {
  const move = decision.disposition?.stockMoveReason ?? null
  const kind = carryKindOf(decision)
  const body: Omit<CarryOutBody, 'version'> = { note: draft.note.trim() || null }
  if (move) {
    const lines = draft.lines.filter((line) => line.quantity.trim() && Number(quantityValue(line.quantity)) > 0)
    if (lines.length === 0 || lines.some((line) => !isQuantity(line.quantity))) return null
    if (move === 'TRANSFER' && !draft.toLocationId) return null
    body.stock = {
      lines: lines.map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId, fromLocationId: line.fromLocationId, quantity: quantityValue(line.quantity), uom: line.uom })),
      ...(move === 'TRANSFER' ? { toLocationId: draft.toLocationId } : {}),
      ...(move === 'ISSUE' && ncr.workOrder ? { workOrderId: ncr.workOrder.id } : {}),
    }
  }
  if (kind === 'repair') {
    if (!draft.followUpId) return null
    body.followUp = { type: 'RepairOrder', id: draft.followUpId }
  }
  if (kind === 'claim' || kind === 'stockAndClaim') {
    if (draft.claimMode === 'name') {
      if (!draft.followUpId) return null
      body.followUp = { type: 'SupplierClaim', id: draft.followUpId }
    } else {
      if (!draft.claimReason) return null
      body.claim = { kind: draft.claimKind, reasonCode: draft.claimReason, reasonNote: draft.claimNote.trim() || null, remedy: draft.claimRemedy || null }
    }
  }
  return body
}

/** Why the carry-out cannot be sent yet (an `ncr-record` key), or null. */
export function carryHeld(decision: Decision, ncr: NcrRecord['ncr'], draft: CarryDraft): string | null {
  const move = decision.disposition?.stockMoveReason ?? null
  const kind = carryKindOf(decision)
  if (move) {
    const lines = draft.lines.filter((line) => line.quantity.trim())
    if (draft.lines.length === 0) return 'carry.heldNoPlaces'
    if (lines.length === 0) return 'carry.heldLines'
    if (lines.some((line) => !isQuantity(line.quantity))) return 'carry.heldLineQuantity'
    if (move === 'TRANSFER' && !draft.toLocationId) return 'carry.heldTo'
  }
  if (kind === 'repair' && !draft.followUpId) return 'carry.heldRepair'
  if ((kind === 'claim' || kind === 'stockAndClaim') && draft.claimMode === 'name' && !draft.followUpId) return 'carry.heldClaim'
  if ((kind === 'claim' || kind === 'stockAndClaim') && draft.claimMode === 'open' && !draft.claimReason) return 'carry.heldClaimReason'
  if ((kind === 'claim' || kind === 'stockAndClaim') && draft.claimMode === 'open' && !ncr.lot) return 'carry.heldClaimLot'
  return carryBodyOf(decision, ncr, draft) ? null : 'carry.heldLines'
}

/** The sum of the lines in the NCR's unit when every line is in it (else null: the API checks only same-unit moves). */
export function linesTotal(draft: CarryDraft, uom: Uom): number | null {
  const lines = draft.lines.filter((line) => line.quantity.trim())
  if (lines.some((line) => line.uom !== uom)) return null
  return Math.round(lines.reduce((sum, line) => sum + (Number(quantityValue(line.quantity)) || 0), 0) * 10000) / 10000
}

// ---- links ----------------------------------------------------------------------------------------------------------------

export type LinkGroup = 'source' | 'follow' | 'other'
const FOLLOW_TYPES = new Set(['ReworkOrder', 'RepairOrder', 'SupplierClaim'])

/** The links in the design's groups: the source, the follow-up records (rework, repair, claim), everything else. */
export function linkGroupsOf(record: NcrRecord): Record<LinkGroup, NcrLink[]> {
  const ncr = record.ncr
  const isSource = (link: NcrLink) => ncr.sourceType === link.recordType && ncr.sourceId === link.recordId
  return {
    source: record.links.filter(isSource),
    follow: record.links.filter((link) => !isSource(link) && FOLLOW_TYPES.has(link.recordType)),
    other: record.links.filter((link) => !isSource(link) && !FOLLOW_TYPES.has(link.recordType)),
  }
}

export const isSourceLink = (record: NcrRecord, link: NcrLink): boolean => record.ncr.sourceType === link.recordType && record.ncr.sourceId === link.recordId

/** A record's address in this company's Office (its own page once built, else the record panel route). */
export const recordHref = (prefix: string, record: { type: string; id: string; label?: string | null }): string =>
  `${prefix}${recordAddress({ type: record.type, id: record.id, ...(record.label ? { label: record.label } : {}) }, OFFICE_PAGES)}`

// ---- dialogs --------------------------------------------------------------------------------------------------------------

interface DialogBase {
  readonly busy: boolean
  readonly notice: NcrNotice | null
}

export type RecordDialog =
  | ({ kind: 'addAction'; draft: ActionDraft } & DialogBase)
  | ({ kind: 'doneAction'; actionId: string; evidence: string; photoName: string | null; hold: HoldDraft } & DialogBase)
  | ({ kind: 'cancelAction'; actionId: string; reason: string } & DialogBase)
  | ({ kind: 'decide'; draft: DecideDraft } & DialogBase)
  | ({ kind: 'carryOut'; decisionId: string; draft: CarryDraft } & DialogBase)
  | ({ kind: 'rework'; decisionId: string; operationId: string; description: string } & DialogBase)
  | ({ kind: 'removeDecision'; decisionId: string } & DialogBase)
  | ({ kind: 'link'; query: string; hits: readonly SearchHit[] | null; searching: boolean; picked: SearchHit | null; note: string } & DialogBase)
  | ({ kind: 'closeHold'; holdId: string; note: string } & DialogBase)
  | ({ kind: 'cancelNcr'; reason: string } & DialogBase)
  | ({ kind: 'register'; description: string } & DialogBase)

export type RecordDialogKind = RecordDialog['kind']

/** What the record's dialogs pick from (each read when a dialog first needs it). */
export interface RecordChoices {
  readonly defects: Choices<DefectChoice>
  readonly dispositions: Choices<DispositionChoice>
  readonly holdReasons: Choices<ReasonChoice>
  readonly claimReasons: Choices<ReasonChoice>
  readonly stock: Choices<StockPlace>
  readonly sites: Choices<SiteChoice>
  readonly operations: Choices<OperationChoice>
  readonly repairs: Choices<RepairChoice>
  readonly claims: Choices<ClaimChoice>
}

export const NO_CHOICES: RecordChoices = {
  defects: choicesReading(),
  dispositions: choicesReading(),
  holdReasons: choicesReading(),
  claimReasons: choicesReading(),
  stock: choicesReading(),
  sites: choicesReading(),
  operations: choicesReading(),
  repairs: choicesReading(),
  claims: choicesReading(),
}

export interface NcrRecordModel {
  readonly prefix: string
  /** The signed-in person (four eyes; "me" in the owner list). */
  readonly me: string
  readonly can: NcrCan
  readonly tab: RecordTab
  readonly loaded: Loaded
  readonly timeZone: string
  readonly now: string
  readonly live: LiveState
  readonly asOf: string | null
  /** Office people by name (owners, deciders, approvers); null while read or when the role cannot list them. */
  readonly people: readonly Person[] | null
  /** The NCR's site, when the sites are read. */
  readonly site: { readonly code: string; readonly name: string } | null
  readonly photos: Choices<NcrPhoto>
  readonly uploading: number
  /** The Problem tab's draft (null: the saved values). */
  readonly draft: ProblemDraft | null
  readonly saving: boolean
  readonly cells: Readonly<Record<string, CellState>>
  readonly choices: RecordChoices
  readonly dialog: RecordDialog | null
  readonly notice: NcrNotice | null
  /** The record changed while a dialog held work: shown instead of reading under the person's hands. */
  readonly stale: string | null
  /** A band action runs. */
  readonly busy: boolean
  readonly close: CloseDialogModel | null
  readonly stepUp: StepUpState
  readonly keysOpen?: boolean
  /** The menu's "Copy number" just copied. */
  readonly copied?: boolean
}

export interface NcrRecordActions {
  onRetry?: () => void
  onDraft?: (patch: Partial<ProblemDraft>) => void
  onDiscard?: () => void
  onSave?: () => void
  onMove?: (to: 'CONTAINED' | 'DECIDED') => void
  onClose?: () => void
  onCopy?: () => void
  onKeys?: (open: boolean) => void
  onDialog?: (dialog: RecordDialog | null) => void
  onSubmitDialog?: () => void
  onNeed?: (choice: keyof RecordChoices) => void
  onFindLink?: (query: string) => void
  onFindRepairs?: (query: string) => void
  onPhotos?: (files: readonly File[]) => void
  onOpenPhoto?: (photo: NcrPhoto) => void
  onActionCell?: (actionId: string, change: { ownerId?: string | null; dueAt?: string | null; description?: string | null }, cell: 'owner' | 'due' | 'description') => void
  onDecisionCell?: (decisionId: string, change: { quantity?: string; note?: string | null }, cell: 'quantity' | 'note') => void
  onApprove?: (decisionId: string) => void
  onUnlink?: (linkId: string) => void
  onDoneFile?: (file: File | null) => void
  onDismissNotice?: () => void
  onReload?: () => void
  close?: { onNote?: (note: string) => void; onSubmit?: () => void; onCancel?: () => void }
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}

/** The tab's own address. */
export const tabHref = (prefix: string, ncrId: string, tab: RecordTab): string => `${prefix}/quality/ncr/${encodeURIComponent(ncrId)}${tab === 'problem' ? '' : `?tab=${tab}`}`

/** The words of a hold's subject type and status in `ncr-record`. */
export const holdStatusKey = (status: string): string => (['ACTIVE', 'RELEASED', 'CLOSED'].includes(status) ? `hold.status.${status}` : 'hold.status.other')

export type { Say }

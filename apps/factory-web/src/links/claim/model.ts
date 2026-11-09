import { z } from 'zod'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { CameraScanner } from '@nexus/ui/floor'
import { ANSWER_WORKING_DAYS, CASE_LIMITS } from '@nexus/factory-domain/sales/portal-returns/rules'
import { isApiError, issuePath, type ApiIssue } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import { CASE_STATES, CLAIM_TYPES, OUTCOMES, type ClaimBody, type ClaimItem, type ClaimPage, type ClaimSent, type ClaimType, type Outcome } from './api'

/**
 * SCR-197 — Report a problem (design links.claim; SAL-334 by link, SAL-385 photos): what the page shows and checks, from
 * the container (ReportProblem.tsx). One task in steps — what you need (a return or a quality complaint; repair, remake
 * and safety come with W2b-5) · which item (from the shipment's or order's items) · tell us more (the questions of the
 * type) · photos (at least two of a damage) · check and send — then the end: the case number and the next step. The form
 * is kept with us as a draft while it is filled in (never on the device); photos stay in the page until the send. Never
 * money: the link holds no price grain. Pure, so the tests hold it.
 */

export const STEPS = ['type', 'item', 'details', 'photos', 'review'] as const
export type Step = (typeof STEPS)[number]

/** The API's limits (contract.ts: the link's complaint takes a serial and batch of 60; a typed name of 120). */
export const LIMITS = Object.freeze({
  reasonNote: CASE_LIMITS.reasonNote,
  serial: 60,
  batchNumber: 60,
  customerRef: CASE_LIMITS.customerRef,
  note: CASE_LIMITS.note,
  description: CASE_LIMITS.description,
  typedName: 120,
  lines: CASE_LIMITS.lines,
  /** Photos on one record (the request, one of its lines, the complaint). */
  photos: CASE_LIMITS.photos,
})

/** The working days the factory takes to answer (the end's words when the API gives no day). */
export const ANSWER_DAYS = ANSWER_WORKING_DAYS

/** A complaint about the delivery as a whole, not one of its items. */
export const WHOLE_DELIVERY = '*'
/** The photo group of a complaint (a return's groups are its items' keys). */
export const CASE_GROUP = 'case'

/** Return reasons that are a damage (the reason list's codes, factory-domain reasons/standard RETURN): photos are needed. */
export const DAMAGE_REASONS: readonly string[] = ['DEFECT', 'DAMAGED_IN_TRANSIT']
/** Photos a damage needs (design sec:photos "at least 2 for damage"). */
export const DAMAGE_PHOTOS = 2

export interface ReturnPick {
  key: string
  quantity: number
  reasonCode: string | null
  reasonNote: string
  serial: string
}

export interface ClaimForm {
  type: ClaimType | null
  /** RETURN: the items that come back, in the order picked. */
  picks: ReturnPick[]
  outcomeWanted: Outcome | null
  note: string
  /** COMPLAINT: one item's key, or WHOLE_DELIVERY. */
  itemKey: string | null
  serial: string
  batchNumber: string
  description: string
  customerRef: string
  typedName: string
}

export const EMPTY_FORM: ClaimForm = Object.freeze({ type: null, picks: [], outcomeWanted: null, note: '', itemKey: null, serial: '', batchNumber: '', description: '', customerRef: '', typedName: '' }) as ClaimForm

/** A photo taken on this page (its bytes stay with the container until the send; `src` shows it). */
export interface PhotoShot {
  id: string
  /** A return item's key, or CASE_GROUP. */
  group: string
  src: string
  marks: number
}

/** A photo after the send: on its way, there, or refused (Try again). */
export type UploadState = 'waiting' | 'sending' | 'sent' | 'failed'

export interface Problem {
  step: Step
  /** Where the page shows it: `type`, `items`, `pick.<key>.<field>`, `complaintItem`, `serial`, `batchNumber`, `description`, `customerRef`, `note`, `photos.<group>`, `typedName`. */
  field: string
  /** A message key of `link-claim`. */
  key: string
  params?: Readonly<Record<string, string | number>>
}

const blank = (value: string | null | undefined): boolean => (value ?? '').trim() === ''
const tooLong = (value: string, max: number): boolean => value.trim().length > max

export const stepIndex = (step: Step): number => STEPS.indexOf(step)
export const nextOf = (step: Step): Step | null => STEPS[stepIndex(step) + 1] ?? null
export const previousOf = (step: Step): Step | null => STEPS[stepIndex(step) - 1] ?? null

export const itemOf = (page: Pick<ClaimPage, 'items'>, key: string | null): ClaimItem | null => (key === null ? null : (page.items.find((item) => item.key === key) ?? null))

/** The items a complaint may name: an order line of the customer's (the API asks for the order line). */
export function complaintItems(page: Pick<ClaimPage, 'items'>): ClaimItem[] {
  const seen = new Set<string>()
  return page.items.filter((item) => item.salesOrderLineId !== null && !seen.has(item.key) && (seen.add(item.key), true))
}

/** What may still come back of the items (the API's `canReturn`): nothing → the return is held with the reason. */
export const returnableCount = (page: Pick<ClaimPage, 'items'>): number => page.items.filter((item) => item.canReturn > 0).length

/** The photo groups of the form: one per item that comes back, or the complaint's one. */
export function photoGroups(form: ClaimForm): string[] {
  if (form.type === 'RETURN') return form.picks.map((pick) => pick.key)
  if (form.type === 'COMPLAINT') return [CASE_GROUP]
  return []
}

/** Photos a group needs: two for a damage (a return's damage reason, every quality complaint), else none. */
export function photosNeeded(form: ClaimForm, group: string): number {
  if (form.type === 'COMPLAINT') return group === CASE_GROUP ? DAMAGE_PHOTOS : 0
  const pick = form.picks.find((entry) => entry.key === group)
  return pick?.reasonCode && DAMAGE_REASONS.includes(pick.reasonCode) ? DAMAGE_PHOTOS : 0
}

/**
 * Every problem of the form, in the order the person meets them (step by step, field by field). Each step's Continue
 * checks its own; Send checks them all. The API checks the same again (and what was sold), so a refusal is rare.
 */
export function problemsOf(form: ClaimForm, page: Pick<ClaimPage, 'items' | 'reasons' | 'types'>, photos: readonly Pick<PhotoShot, 'group'>[]): Problem[] {
  const problems: Problem[] = []
  if (form.type === null || !page.types.includes(form.type)) return [{ step: 'type', field: 'type', key: 'check.type' }]
  if (form.type === 'RETURN') {
    if (form.picks.length === 0) problems.push({ step: 'item', field: 'items', key: returnableCount(page) === 0 ? 'check.nothingBack' : 'check.items' })
    if (form.picks.length > LIMITS.lines) problems.push({ step: 'item', field: 'items', key: 'check.manyItems', params: { max: LIMITS.lines } })
    for (const pick of form.picks) {
      const item = itemOf(page, pick.key)
      const at = (field: string) => `pick.${pick.key}.${field}`
      if (!item) {
        problems.push({ step: 'item', field: at('quantity'), key: 'check.itemGone' })
        continue
      }
      if (!Number.isInteger(pick.quantity) || pick.quantity < 1) problems.push({ step: 'item', field: at('quantity'), key: 'check.quantityMin' })
      else if (pick.quantity > item.canReturn) problems.push({ step: 'item', field: at('quantity'), key: 'check.quantityMax', params: { max: item.canReturn } })
      if (tooLong(pick.serial, LIMITS.serial)) problems.push({ step: 'item', field: at('serial'), key: 'check.long', params: { max: LIMITS.serial } })
    }
    for (const pick of form.picks) {
      const at = (field: string) => `pick.${pick.key}.${field}`
      const reason = page.reasons.find((entry) => entry.code === pick.reasonCode)
      if (!reason) problems.push({ step: 'details', field: at('reason'), key: 'check.reason' })
      else if (reason.needsNote && blank(pick.reasonNote)) problems.push({ step: 'details', field: at('reasonNote'), key: 'check.reasonNote' })
      if (tooLong(pick.reasonNote, LIMITS.reasonNote)) problems.push({ step: 'details', field: at('reasonNote'), key: 'check.long', params: { max: LIMITS.reasonNote } })
    }
    if (tooLong(form.note, LIMITS.note)) problems.push({ step: 'details', field: 'note', key: 'check.long', params: { max: LIMITS.note } })
  } else {
    const items = complaintItems(page)
    if (form.itemKey === null ? items.length > 0 : form.itemKey !== WHOLE_DELIVERY && !items.some((item) => item.key === form.itemKey)) problems.push({ step: 'item', field: 'complaintItem', key: 'check.complaintItem' })
    if (tooLong(form.serial, LIMITS.serial)) problems.push({ step: 'item', field: 'serial', key: 'check.long', params: { max: LIMITS.serial } })
    if (tooLong(form.batchNumber, LIMITS.batchNumber)) problems.push({ step: 'item', field: 'batchNumber', key: 'check.long', params: { max: LIMITS.batchNumber } })
    if (blank(form.description)) problems.push({ step: 'details', field: 'description', key: 'check.description' })
    else if (tooLong(form.description, LIMITS.description)) problems.push({ step: 'details', field: 'description', key: 'check.long', params: { max: LIMITS.description } })
  }
  if (tooLong(form.customerRef, LIMITS.customerRef)) problems.push({ step: 'details', field: 'customerRef', key: 'check.long', params: { max: LIMITS.customerRef } })
  for (const group of photoGroups(form)) {
    const needed = photosNeeded(form, group)
    const have = photos.filter((photo) => photo.group === group).length
    if (have < needed) problems.push({ step: 'photos', field: `photos.${group}`, key: 'check.photos', params: { count: needed - have, needed } })
  }
  if (tooLong(form.typedName, LIMITS.typedName)) problems.push({ step: 'review', field: 'typedName', key: 'check.long', params: { max: LIMITS.typedName } })
  return problems
}

export const problemsIn = (problems: readonly Problem[], step: Step): Problem[] => problems.filter((problem) => problem.step === step)

/** The first step with a problem before (or at) `step`, or null: Continue and the Stepper never skip a problem. */
export function firstBlocked(problems: readonly Problem[], upTo: Step): Step | null {
  for (const step of STEPS.slice(0, stepIndex(upTo) + 1)) if (problems.some((problem) => problem.step === step)) return step
  return null
}

/** A problem's words for one field (the first one there), or undefined. */
export const fieldProblem = (problems: readonly Problem[], field: string): Problem | undefined => problems.find((problem) => problem.field === field)

const trimmed = (value: string): string | null => (blank(value) ? null : value.trim())

/** The body the API takes for the form (call it once `problemsOf` is empty). */
export function bodyOf(form: ClaimForm, page: Pick<ClaimPage, 'items'>): ClaimBody {
  const typedName = trimmed(form.typedName)
  if (form.type === 'RETURN') {
    return {
      type: 'RETURN',
      typedName,
      lines: form.picks.flatMap((pick) => {
        const item = itemOf(page, pick.key)
        return item
          ? [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: pick.quantity, reasonCode: pick.reasonCode ?? '', reasonNote: trimmed(pick.reasonNote), serial: trimmed(pick.serial) }]
          : []
      }),
      outcomeWanted: form.outcomeWanted,
      customerRef: trimmed(form.customerRef),
      note: trimmed(form.note),
    }
  }
  const item = form.itemKey && form.itemKey !== WHOLE_DELIVERY ? itemOf(page, form.itemKey) : null
  return {
    type: 'COMPLAINT',
    typedName,
    description: form.description.trim(),
    salesOrderLineId: item?.salesOrderLineId ?? null,
    size: item?.size ?? null,
    serial: trimmed(form.serial),
    batchNumber: trimmed(form.batchNumber),
    customerRef: trimmed(form.customerRef),
  }
}

// ---- editing the form (pure: the container keeps the state) --------------------------------------------------------

/** Pick or drop an item that comes back (one piece to start, or all when only one is left). */
export function togglePick(form: ClaimForm, item: ClaimItem): ClaimForm {
  if (form.picks.some((pick) => pick.key === item.key)) return { ...form, picks: form.picks.filter((pick) => pick.key !== item.key) }
  if (item.canReturn < 1) return form
  return { ...form, picks: [...form.picks, { key: item.key, quantity: 1, reasonCode: null, reasonNote: '', serial: '' }] }
}

export const updatePick = (form: ClaimForm, key: string, change: Partial<Omit<ReturnPick, 'key'>>): ClaimForm => ({ ...form, picks: form.picks.map((pick) => (pick.key === key ? { ...pick, ...change } : pick)) })

/** Changing what you need keeps what was typed for the other type (switching back finds it); photos follow the groups. */
export const chooseType = (form: ClaimForm, type: ClaimType): ClaimForm => ({ ...form, type })

/** The photos of groups the form no longer has (an item dropped, the type switched) are left out of the send. */
export const photosInForm = <T extends Pick<PhotoShot, 'group'>>(form: ClaimForm, photos: readonly T[]): T[] => {
  const groups = new Set(photoGroups(form))
  return photos.filter((photo) => groups.has(photo.group))
}

export const photosOf = <T extends Pick<PhotoShot, 'group'>>(photos: readonly T[], group: string): T[] => photos.filter((photo) => photo.group === group)

/** Why "Add a photo" is held for a group (a message key), null when it may go. */
export const addPhotoHeld = (photos: readonly Pick<PhotoShot, 'group'>[], group: string): string | null => (photosOf(photos, group).length >= LIMITS.photos ? 'photos.held.max' : null)

// ---- the draft kept with us (B-W2b-163) ------------------------------------------------------------------------------

const pickSchema = z.object({ key: z.string().max(200), quantity: z.number().int(), reasonCode: z.string().max(40).nullable(), reasonNote: z.string().max(4000), serial: z.string().max(400) })
const draftDataSchema = z.object({
  v: z.literal(1),
  step: z.enum(STEPS),
  form: z.object({
    type: z.enum(CLAIM_TYPES).nullable(),
    picks: z.array(pickSchema).max(LIMITS.lines),
    outcomeWanted: z.enum(OUTCOMES).nullable(),
    note: z.string().max(8000),
    itemKey: z.string().max(200).nullable(),
    serial: z.string().max(400),
    batchNumber: z.string().max(400),
    description: z.string().max(8000),
    customerRef: z.string().max(400),
    typedName: z.string().max(400),
  }),
})

/** The draft's data (no photo: those stay in the page until the send). */
export const draftDataOf = (form: ClaimForm, step: Step): Record<string, unknown> => ({ v: 1, step, form: { ...form, picks: form.picks.map((pick) => ({ ...pick })) } })

/** A form worth keeping: something was chosen or typed. */
export const worthKeeping = (form: ClaimForm): boolean => JSON.stringify({ ...form }) !== JSON.stringify({ ...EMPTY_FORM })

/**
 * A draft read back, made to fit the page as it is now: items that can no longer come back and reasons that left the list
 * are dropped, quantities kept within what is left; a type the link does not take is cleared. Null for an empty draft or
 * one this page cannot read.
 */
export function formFromDraft(data: unknown, page: Pick<ClaimPage, 'items' | 'reasons' | 'types'>): { form: ClaimForm; step: Step } | null {
  const read = draftDataSchema.safeParse(data)
  if (!read.success) return null
  const saved = read.data.form
  const reasons = new Set(page.reasons.map((reason) => reason.code))
  const picks = saved.picks.flatMap((pick) => {
    const item = itemOf(page, pick.key)
    if (!item || item.canReturn < 1) return []
    return [{ ...pick, quantity: Math.min(Math.max(1, pick.quantity), item.canReturn), reasonCode: pick.reasonCode && reasons.has(pick.reasonCode) ? pick.reasonCode : null }]
  })
  const itemKey = saved.itemKey === WHOLE_DELIVERY || complaintItems(page).some((item) => item.key === saved.itemKey) ? saved.itemKey : null
  const form: ClaimForm = { ...saved, type: saved.type && page.types.includes(saved.type) ? saved.type : null, picks, itemKey }
  if (!worthKeeping(form)) return null
  return { form, step: form.type === null ? 'type' : read.data.step }
}

// ---- the server's answers ---------------------------------------------------------------------------------------------

/** A failed read as the link state the frame shows. */
export function readRefusal(error: unknown): LinkState {
  if (isApiError(error) && error.kind === 'not_found') return 'unavailable'
  if (isApiError(error) && error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}

/** Where an issue of the API's refusal belongs (`body/lines/<i>/quantity` …), in this page's words. */
export function issueProblem(issue: ApiIssue, form: ClaimForm): Problem {
  const path = issuePath(issue).replace(/\./g, '/')
  const line = /^body\/lines\/(\d+)\/(\w+)/.exec(path)
  if (line) {
    const pick = form.picks[Number(line[1])]
    const field = line[2]!
    if (!pick) return { step: 'item', field: 'items', key: 'refusal.field' }
    if (field === 'reasonCode') return { step: 'details', field: `pick.${pick.key}.reason`, key: 'check.reason' }
    if (field === 'reasonNote') return { step: 'details', field: `pick.${pick.key}.reasonNote`, key: 'check.reasonNote' }
    if (field === 'serial') return { step: 'item', field: `pick.${pick.key}.serial`, key: 'refusal.field' }
    return { step: 'item', field: `pick.${pick.key}.quantity`, key: 'refusal.quantity' }
  }
  if (/^body\/lines\/(\d+)$/.test(path)) {
    const pick = form.picks[Number(path.split('/')[2])]
    return pick ? { step: 'item', field: `pick.${pick.key}.quantity`, key: 'refusal.quantity' } : { step: 'item', field: 'items', key: 'refusal.field' }
  }
  if (path.startsWith('body/lines')) return { step: 'item', field: 'items', key: 'check.items' }
  if (path === 'body/description') return { step: 'details', field: 'description', key: 'check.description' }
  if (path === 'body/customerRef' || path === 'body/note' || path === 'body/outcomeWanted') return { step: 'details', field: path.slice(5), key: 'refusal.field' }
  if (path === 'body/salesOrderLineId' || path === 'body/size') return { step: 'item', field: 'complaintItem', key: 'check.complaintItem' }
  if (path === 'body/serial' || path === 'body/batchNumber') return { step: 'item', field: path.slice(5), key: 'refusal.field' }
  if (path === 'body/typedName') return { step: 'review', field: 'typedName', key: 'refusal.field' }
  return { step: 'review', field: 'send', key: 'refusal.field' }
}

/**
 * A refused send in this page's words: the link state when it is the link's (gone, the wrong person), the fields the API
 * named (shown where they are; the page goes to the first), whether the page is read again (what may come back changed),
 * and whether a retry keeps the same Idempotency-Key (the answer was lost: the API replays the case, never a second one).
 */
export function sendRefusal(error: unknown, form: ClaimForm): { key: string; link?: LinkState; issues: Problem[]; reload: boolean; keepKey: boolean } {
  if (!isApiError(error)) return { key: 'problem.internal', issues: [], reload: false, keepKey: true }
  const issues = error.issues.map((issue) => issueProblem(issue, form))
  switch (error.kind) {
    case 'not_found':
      return { key: 'problem.gone', link: 'unavailable', issues: [], reload: false, keepKey: false }
    case 'forbidden':
      return { key: 'problem.wrongPerson', link: 'wrong_person', issues: [], reload: false, keepKey: false }
    case 'invalid':
      return { key: 'problem.invalid', issues, reload: false, keepKey: false }
    case 'conflict':
      return issues.some((issue) => issue.key === 'refusal.quantity') ? { key: 'problem.aboveSold', issues, reload: true, keepKey: false } : { key: 'problem.changed', issues: [], reload: true, keepKey: false }
    case 'rate_limited':
      return { key: 'problem.rateLimited', issues: [], reload: false, keepKey: true }
    case 'unavailable':
      return { key: 'problem.unavailable', issues: [], reload: false, keepKey: true }
    default:
      return { key: 'problem.internal', issues: [], reload: false, keepKey: true }
  }
}

/** A photo's line on the return: the item's place among the picks gives the line's seq (the API numbers them 10, 20 …). */
export function lineIdFor(group: string, picks: readonly Pick<ReturnPick, 'key'>[], lines: readonly { id: string; seq: number }[]): string | null {
  const index = picks.findIndex((pick) => pick.key === group)
  if (index < 0) return null
  return lines.find((line) => line.seq === (index + 1) * 10)?.id ?? null
}

/** How the photos went after the send. */
export function uploadSummary(uploads: Readonly<Record<string, UploadState>>): { total: number; sent: number; failed: number; busy: number } {
  const states = Object.values(uploads)
  return { total: states.length, sent: states.filter((state) => state === 'sent').length, failed: states.filter((state) => state === 'failed').length, busy: states.filter((state) => state === 'waiting' || state === 'sending').length }
}

/** A case's state in this page's words (`case.state.<STATE>`), or null for a state the page does not know. */
export const caseStateKey = (state: string): string | null => ((CASE_STATES as readonly string[]).includes(state) ? `case.state.${state}` : null)

/** The case's tone in the list: the customer's move, a closed case, or ours. */
export const caseTone = (entry: { open: boolean; next: { forYou: boolean } }): 'warning' | 'neutral' | 'info' => (!entry.open ? 'neutral' : entry.next.forYou ? 'warning' : 'info')

/** The link still takes a report: live and a use left (else Send and "Report another problem" are held with why). */
export function sendHeldKey(page: Pick<ClaimPage, 'link'> | null): string | null {
  if (!page) return null
  if (!page.link.live) return 'send.held.expired'
  if (page.link.usesLeft < 1) return 'send.held.used'
  return null
}

// ---- the page's model -------------------------------------------------------------------------------------------------

export interface DraftModel {
  status: SaveStatusState
  /** When a draft was found on opening (the banner "We kept what you wrote"), until dismissed. */
  restoredAt: string | null
  /** "Finish later" was pressed and the save confirmed: the note says how to come back. */
  later: boolean
}

export interface DoneModel {
  sent: ClaimSent
  /** The form as sent (the end's facts). */
  form: ClaimForm
  /** Each photo's state after the send, by photo id. */
  uploads: Readonly<Record<string, UploadState>>
}

export interface ClaimViewModel {
  /** The link itself: `valid` once the page was read (or while it is). */
  link: LinkState
  page: ClaimPage | null
  /** A read failed, or a send was refused: a message key of `link-claim` (a banner). */
  problem: string | null
  form: ClaimForm
  step: Step
  /** Steps whose Continue was pressed (their problems show at the fields from then on). */
  checked: readonly Step[]
  /** The fields the API named in its refusal. */
  issues: readonly Problem[]
  photos: readonly PhotoShot[]
  /** "Add a photo" open for a group. */
  photoFor: string | null
  /** The camera open to read a serial: `serial` (the complaint's) or a return item's key. */
  scanFor: string | null
  draft: DraftModel
  send: 'idle' | 'busy'
  done: DoneModel | null
  /** A case's document or the return instructions being opened (its id), or one that failed to open. */
  opening: { id: string; failed: boolean } | null
  timeZone?: string
  /** A photo to mark from the start in "Add a photo" (the design cases; the camera in real use). */
  photoSample?: { src: string; width: number; height: number }
}

export interface ClaimActions {
  onRetry?: () => void
  onType?: (type: ClaimType) => void
  onTogglePick?: (key: string) => void
  onPick?: (key: string, change: Partial<Omit<ReturnPick, 'key'>>) => void
  onComplaintItem?: (key: string) => void
  onField?: (field: 'serial' | 'batchNumber' | 'description' | 'customerRef' | 'note' | 'typedName', value: string) => void
  onOutcome?: (outcome: Outcome | null) => void
  onStep?: (step: Step) => void
  onNext?: () => void
  onBack?: () => void
  onAddPhoto?: (group: string) => void
  onPhoto?: (photo: CapturedPhoto) => void | Promise<void>
  onPhotoClose?: () => void
  onRemovePhoto?: (id: string) => void
  onScan?: (target: string) => void
  onScanned?: (code: string) => void
  onScanClose?: () => void
  /** The camera reader for a serial (the container passes ZXing; the design cases none). */
  scanner?: CameraScanner
  onFinishLater?: () => void
  onSaveRetry?: () => void
  onStartAgain?: () => void
  onDismissRestored?: () => void
  onSend?: () => void
  onRetryPhotos?: () => void
  onAnother?: () => void
  onOpenDocument?: (fileId: string) => void
  onInstructions?: (returnId: string, number: string) => void
}

/** The page's own words for where a field sits, so the focus can go there (an element id). */
export const fieldId = (field: string): string => `fw-cl-${field.replace(/[^a-zA-Z0-9-]/g, '-')}`

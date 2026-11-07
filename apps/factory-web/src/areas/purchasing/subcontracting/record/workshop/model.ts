import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { words, type Words } from '../../model'
import type { Loaded, ReceiveDraft } from '../record-model'
import type { AcceptBody, DeclineBody, DeclineReason, ForWorkshop, JobLinkBody, KitBody, ProgressBody, ReceivePrefill, ReturnBody, WorkshopAnswer, WorkshopJob } from './api'

/**
 * What the workshop said, on the subcontract order's Kit tab (B-W2b-176; design purchasing.subcontracting › Kit "received by
 * the workshop (W2b link or portal)"; Owner answer C3: the office acts for a terzista without e-mail), pure: what each part
 * shows, why each act is held (the permission first — the answer's `office.manage` / `office.receive` —, then the job's
 * facts, in OUR words: the API's held sentences say only whether), the dialogs' drafts, what each write sends, a refusal
 * in words, and the record's Receive back prefilled from an announced send-back. Words are keys of `subcontract-workshop`.
 * Nothing here is money (Owner answer C2).
 */

export type { Words }

/** A dialog of the panel and what it holds while it is open. */
export type WorkshopDialog =
  | { kind: 'link'; mode: 'mail' | 'hand'; contactId: string; email: string; language: '' | 'it' | 'en' }
  | { kind: 'date'; decision: 'ACCEPTED' | 'REFUSED' }
  | { kind: 'answer'; mode: 'accept' | 'move' | 'decline'; proposedDate: string; reason: string; declineReason: DeclineReason | ''; note: string; name: string }
  | { kind: 'kit'; all: boolean; lines: Readonly<Record<string, { quantity: string; note: string }>> }
  | { kind: 'progress'; cells: Readonly<Record<string, string>>; finishBy: string; note: string; name: string }
  | {
      kind: 'returns'
      rows: Readonly<Record<string, { finished: string; scrapped: string; reasonCode: string }>>
      material: Readonly<Record<string, string>>
      parcels: string
      expectedDate: string
      weCollect: boolean
      ddtNumber: string
      ddtDate: string
      note: string
      name: string
    }
  | { kind: 'cancelReturn'; returnNoticeId: string; reason: string }

export interface WorkshopPanelModel {
  answer: Loaded<WorkshopAnswer>
  /** The read takes longer than a second ("Still loading…"). */
  slow: boolean
  busy: boolean
  dialog: WorkshopDialog | null
  problem: Words | null
  notice: { tone: 'success' | 'danger' | 'info' | 'warning'; words: Words } | null
  /** The job link's address, shown ONCE after "Get the link to pass on" (never kept). */
  handed: string | null
  timeZone: string
  today: string
}

export interface WorkshopActions {
  onRetry?: () => void
  onDialog?: (dialog: WorkshopDialog | null) => void
  onSendLink?: () => void
  onDecideDate?: () => void
  onAnswer?: () => void
  onKit?: () => void
  onProgress?: () => void
  onReturn?: () => void
  onCancelReturn?: () => void
  onReceiveFrom?: (returnNoticeId: string) => void
  onCopyLink?: () => void
  onForgetLink?: () => void
  onDismissNotice?: () => void
}

const ENDED = new Set(['BACK', 'CLOSED', 'CANCELLED'])
const isWhole = (text: string): boolean => /^\d{1,6}$/.test(text.trim())
const isQuantity = (text: string): boolean => /^\d{1,14}([.,]\d{1,4})?$/.test(text.trim())
const decimal = (text: string): string => text.trim().replace(',', '.')
const blank = (text: string): boolean => text.trim() === ''
const trimmedOrNot = <K extends string>(key: K, text: string): Partial<Record<K, string>> => (blank(text) ? {} : ({ [key]: text.trim() } as Record<K, string>))

// ---- the parts ---------------------------------------------------------------------------------------------------------------

export const STATE_TONE: Readonly<Record<WorkshopJob['state'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  TO_ANSWER: 'warning',
  DECLINED: 'danger',
  WAITING_KIT: 'info',
  IN_WORK: 'info',
  PARTLY_BACK: 'info',
  BACK: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
}

/** How the workshop can be reached: by e-mail, its portal, or neither (then the office records its answers: C3). */
export function reachOf(answer: Pick<WorkshopAnswer, 'reach'>): 'mail' | 'portal' | 'none' {
  if (answer.reach.contacts.length > 0) return 'mail'
  return answer.reach.portalOn && answer.reach.portalPeople > 0 ? 'portal' : 'none'
}

/** Kit lines that went out (the workshop checks those). */
export const sentLines = (job: WorkshopJob) => job.kit.lines.filter((line) => line.status === 'SENT')

// ---- why an act is held ----------------------------------------------------------------------------------------------------

type JobAct = keyof WorkshopJob['acts']

/** Why the office cannot write this act of the workshop for it now, or null. */
export function actHeld(answer: WorkshopAnswer, act: JobAct): Words | null {
  if (!answer.office.manage) return words('held.manage')
  const { job } = answer
  if (job.acts[act] === null) return null
  if (ENDED.has(job.state)) return words('held.ended')
  if (job.answer.declinedAt) return words('held.declined')
  if (act === 'accept' || act === 'decline') {
    if (job.answer.acceptedAt) return words('held.answered')
    if (act === 'decline' && job.status === 'PARTLY_RECEIVED') return words('held.declinePartly')
    return words('held.notSent')
  }
  if (!job.answer.acceptedAt) return words('held.acceptFirst')
  if (act === 'kit') return words('held.kitNone')
  if (act === 'sendBack') return job.status === 'ISSUED' ? words('held.noKitYet') : words('held.nothingToAnnounce')
  return words('held.generic')
}

/** The answer dialog opens while the workshop may accept or decline. */
export const answerHeld = (answer: WorkshopAnswer): Words | null => {
  const accept = actHeld(answer, 'accept')
  const decline = actHeld(answer, 'decline')
  return accept && decline ? accept : null
}

export function linkHeld(answer: WorkshopAnswer): Words | null {
  if (!answer.office.manage) return words('held.manage')
  if (answer.office.sendLink === null) return null
  const { job } = answer
  if (job.answer.acceptedAt) return words('held.link.accepted')
  if (job.answer.declinedAt) return words('held.declined')
  if (job.status === 'DRAFT') return words('held.link.draft')
  return words('held.ended')
}

export function dateHeld(answer: WorkshopAnswer): Words | null {
  if (!answer.office.manage) return words('held.manage')
  if (answer.office.decideDate === null) return null
  if (answer.job.answer.proposedDate === null) return words('held.date.none')
  if (answer.job.answer.dateDecision) return words('held.date.answered')
  return words('held.ended')
}

export const receiveHeld = (answer: WorkshopAnswer): Words | null => (answer.office.receive ? null : words('held.receive'))

// ---- the dialogs: fresh drafts -----------------------------------------------------------------------------------------------

export function linkDraft(answer: WorkshopAnswer): WorkshopDialog {
  const contact = answer.reach.contacts[0]
  return { kind: 'link', mode: contact ? 'mail' : 'hand', contactId: contact?.id ?? '', email: '', language: '' }
}

export const answerDraft = (answer: WorkshopAnswer): WorkshopDialog => ({ kind: 'answer', mode: actHeld(answer, 'accept') ? 'decline' : 'accept', proposedDate: '', reason: '', declineReason: '', note: '', name: '' })

export const kitDraft = (job: WorkshopJob): WorkshopDialog => ({
  kind: 'kit',
  all: true,
  lines: Object.fromEntries(sentLines(job).filter((line) => line.check === null).map((line) => [line.id, { quantity: line.quantity, note: '' }])),
})

/** A progress cell's key: the operation and its size cell ('' = the operation as a whole). */
export const cellKey = (operationId: string, workOrderSizeId: string | null): string => `${operationId}|${workOrderSizeId ?? ''}`

export const progressDraft = (): WorkshopDialog => ({ kind: 'progress', cells: {}, finishBy: '', note: '', name: '' })

export const returnsDraft = (job: WorkshopJob, today: string): WorkshopDialog => ({
  kind: 'returns',
  rows: Object.fromEntries(job.operations.filter((operation) => operation.announceable > 0).map((operation) => [operation.id, { finished: String(Math.min(operation.ready, operation.announceable)), scrapped: '0', reasonCode: '' }])),
  material: {},
  parcels: '1',
  expectedDate: today,
  weCollect: false,
  ddtNumber: '',
  ddtDate: '',
  note: '',
  name: '',
})

// ---- the dialogs: why the confirm is held ------------------------------------------------------------------------------------

export function dialogHeld(dialog: WorkshopDialog, answer: WorkshopAnswer, today: string): Words | null {
  const { job } = answer
  switch (dialog.kind) {
    case 'link':
      if (dialog.mode === 'mail' && !dialog.contactId && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dialog.email.trim())) return words('link.held.address')
      return null
    case 'date':
      return null
    case 'answer':
      if (dialog.mode === 'move') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dialog.proposedDate)) return words('answer.held.date')
        if (dialog.proposedDate < today || dialog.proposedDate < job.orderDate) return words('answer.held.past')
        if (dialog.proposedDate === job.expectedBackDate) return words('answer.held.same')
        if (blank(dialog.reason)) return words('answer.held.reason')
      }
      if (dialog.mode === 'decline') {
        if (!dialog.declineReason) return words('answer.held.declineReason')
        if (dialog.declineReason === 'OTHER' && blank(dialog.note)) return words('answer.held.note')
      }
      return null
    case 'kit': {
      if (dialog.all) return Object.keys(dialog.lines).length === 0 ? words('held.kitNone') : null
      for (const line of sentLines(job).filter((entry) => entry.check === null)) {
        const draft = dialog.lines[line.id]
        if (!draft || !isQuantity(draft.quantity)) return words('kit.held.count', { line: line.seq })
        const counted = Number(decimal(draft.quantity))
        if (counted > Number(line.quantity)) return words('kit.held.more', { line: line.seq, sent: plain(line.quantity) })
        if (counted < Number(line.quantity) && blank(draft.note)) return words('kit.held.note', { line: line.seq })
      }
      return null
    }
    case 'progress': {
      let total = 0
      for (const [key, text] of Object.entries(dialog.cells)) {
        if (blank(text)) continue
        if (!isWhole(text)) return words('progress.held.whole')
        const [operationId, cellId] = key.split('|')
        const operation = job.operations.find((entry) => entry.id === operationId)
        if (!operation) continue
        const count = Number(text.trim())
        const cell = cellId ? operation.sizes.find((size) => size.workOrderSizeId === cellId) : undefined
        if (cell && cell.finished + count > cell.pieces) return words('progress.held.cell', { line: operation.seq, size: `${cell.colourway} ${cell.size}`, left: cell.pieces - cell.finished })
        const forOperation = Object.entries(dialog.cells)
          .filter(([other, value]) => other.startsWith(`${operationId}|`) && isWhole(value))
          .reduce((sum, [, value]) => sum + Number(value.trim()), 0)
        if (operation.finished + forOperation > operation.pieces) return words('progress.held.operation', { line: operation.seq, left: operation.pieces - operation.finished })
        total += count
      }
      if (total === 0) return words('progress.held.nothing')
      if (dialog.finishBy && dialog.finishBy < job.orderDate) return words('progress.held.finishBy')
      return null
    }
    case 'returns': {
      let pieces = 0
      for (const [operationId, row] of Object.entries(dialog.rows)) {
        const operation = job.operations.find((entry) => entry.id === operationId)
        if (!operation) continue
        if (!isWhole(row.finished || '0') || !isWhole(row.scrapped || '0')) return words('returns.held.whole', { line: operation.seq })
        const finished = Number((row.finished || '0').trim())
        const scrapped = Number((row.scrapped || '0').trim())
        if (scrapped > 0 && !row.reasonCode) return words('returns.held.reason', { line: operation.seq })
        if (finished + scrapped > operation.announceable) return words('returns.held.more', { line: operation.seq, left: operation.announceable })
        pieces += finished + scrapped
      }
      if (pieces === 0) return words('returns.held.nothing')
      for (const [kitLineId, text] of Object.entries(dialog.material)) {
        if (blank(text)) continue
        const line = job.kit.lines.find((entry) => entry.id === kitLineId)
        if (!isQuantity(text) || Number(decimal(text)) <= 0) return words('returns.held.material', { line: line?.seq ?? 0 })
        if (line && Number(decimal(text)) > Number(line.quantity)) return words('returns.held.materialMore', { line: line.seq, sent: plain(line.quantity) })
      }
      if (!isWhole(dialog.parcels) || Number(dialog.parcels) < 1 || Number(dialog.parcels) > 9999) return words('returns.held.parcels')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dialog.expectedDate) || dialog.expectedDate < today) return words('returns.held.day')
      if (dialog.ddtDate && blank(dialog.ddtNumber)) return words('returns.held.ddtNumber')
      if (dialog.ddtDate && dialog.ddtDate > dialog.expectedDate) return words('returns.held.ddtDate')
      return null
    }
    case 'cancelReturn':
      return blank(dialog.reason) ? words('cancelReturn.held.reason') : null
  }
}

// ---- the dialogs: what each write sends --------------------------------------------------------------------------------------

export function linkBody(dialog: Extract<WorkshopDialog, { kind: 'link' }>): JobLinkBody {
  if (dialog.mode === 'hand') return { send: false, ...(dialog.language ? { language: dialog.language } : {}) }
  return { send: true, ...(dialog.contactId ? { contactId: dialog.contactId } : { email: dialog.email.trim() }), ...(dialog.language ? { language: dialog.language } : {}) }
}

export function answerAct(dialog: Extract<WorkshopDialog, { kind: 'answer' }>): ForWorkshop {
  if (dialog.mode === 'decline') {
    const body: DeclineBody = { reason: dialog.declineReason as DeclineReason, ...trimmedOrNot('note', dialog.note), ...trimmedOrNot('name', dialog.name) }
    return { act: 'decline', body }
  }
  const body: AcceptBody = { ...(dialog.mode === 'move' ? { proposedDate: dialog.proposedDate, reason: dialog.reason.trim() } : {}), ...trimmedOrNot('name', dialog.name) }
  return { act: 'accept', body }
}

export function kitAct(dialog: Extract<WorkshopDialog, { kind: 'kit' }>): ForWorkshop {
  if (dialog.all) return { act: 'kit', body: { all: true } }
  const body: KitBody = { lines: Object.entries(dialog.lines).map(([kitLineId, line]) => ({ kitLineId, quantity: decimal(line.quantity), ...trimmedOrNot('note', line.note) })) }
  return { act: 'kit', body }
}

export function progressAct(dialog: Extract<WorkshopDialog, { kind: 'progress' }>): ForWorkshop {
  const entries = Object.entries(dialog.cells)
    .filter(([, text]) => isWhole(text) && Number(text.trim()) > 0)
    .map(([key, text]) => {
      const [operationId, cellId] = key.split('|') as [string, string]
      return { operationId, ...(cellId ? { workOrderSizeId: cellId } : {}), finished: Number(text.trim()) }
    })
  const body: ProgressBody = { entries, ...(dialog.finishBy ? { finishBy: dialog.finishBy } : {}), ...trimmedOrNot('note', dialog.note), ...trimmedOrNot('name', dialog.name) }
  return { act: 'progress', body }
}

export function returnsAct(dialog: Extract<WorkshopDialog, { kind: 'returns' }>): ForWorkshop {
  const quantities = Object.entries(dialog.rows)
    .map(([operationId, row]) => ({ operationId, finished: Number((row.finished || '0').trim()), scrapped: Number((row.scrapped || '0').trim()), reasonCode: row.reasonCode }))
    .filter((row) => row.finished + row.scrapped > 0)
    .map(({ reasonCode, ...row }) => (row.scrapped > 0 ? { ...row, reasonCode } : row))
  const materialBack = Object.entries(dialog.material)
    .filter(([, text]) => !blank(text))
    .map(([kitLineId, text]) => ({ kitLineId, quantity: decimal(text) }))
  const body: ReturnBody = {
    quantities,
    ...(materialBack.length > 0 ? { materialBack } : {}),
    parcels: Number(dialog.parcels.trim()),
    expectedDate: dialog.expectedDate,
    weCollect: dialog.weCollect,
    ...(blank(dialog.ddtNumber) ? {} : { ddt: { number: dialog.ddtNumber.trim(), ...(dialog.ddtDate ? { date: dialog.ddtDate } : {}) } }),
    ...trimmedOrNot('note', dialog.note),
    ...trimmedOrNot('name', dialog.name),
  }
  return { act: 'returns', body }
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** A write's refusal in words: the field it names first, then its kind. Never the API's English sentence. */
export function writeProblem(error: unknown): Words {
  if (!isApiError(error)) return words('problem.write')
  const paths = error.issues.map((issue) => issuePath(issue))
  const has = (part: string) => paths.some((path) => path.includes(part))
  if (error.kind === 'invalid') {
    if (has('proposedDate')) return words('refused.proposedDate')
    if (has('email') || has('contactId')) return words('refused.address')
    if (has('reasonCode')) return words('refused.scrapReason')
    if (has('note')) return words('refused.note')
    if (has('reason')) return words('refused.reason')
    if (has('lines')) return words('refused.kit')
    if (has('entries')) return words('refused.progress')
    if (has('materialBack')) return words('refused.material')
    if (has('quantities')) return words('refused.returns')
    if (has('parcels')) return words('refused.parcels')
    if (has('expectedDate')) return words('refused.day')
    if (has('ddt')) return words('refused.ddt')
    return words('problem.invalid')
  }
  if (error.kind === 'conflict') return error.code === 'stale_version' || /version|changed/i.test(error.message) ? words('problem.changed') : words('problem.state')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return words('problem.forbidden')
  if (error.kind === 'unavailable') return words('problem.offline')
  if (error.kind === 'rate_limited') return words('problem.slowDown')
  if (error.kind === 'not_found') return words('problem.gone')
  return words('problem.write')
}

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

// ---- the record's Receive back, prefilled -------------------------------------------------------------------------------------

/** A stock row's key as the record's Receive back keeps it (record-model `stockKey`). */
const returnKey = (row: Pick<ReceivePrefill['returns'][number], 'itemId' | 'itemColourId' | 'lotId' | 'hideId'>): string => [row.itemId, row.itemColourId ?? '', row.lotId ?? '', row.hideId ?? ''].join('|')

/**
 * The record's fresh Receive back draft, filled from an announced send-back (design: "it prefills the receive back"): one
 * line per operation and bundle with the finished pieces as good and the scrapped with their reason code, the workshop's
 * DDT, the note, the unused material it announced (the places are the office's to pick), and the notice it answers.
 */
export function receiveDraftFrom(base: ReceiveDraft, prefill: ReceivePrefill): ReceiveDraft {
  return {
    ...base,
    ddtNumber: prefill.supplierDdt?.number ?? base.ddtNumber,
    ddtDate: prefill.supplierDdt?.date ?? base.ddtDate,
    lines: prefill.lines.map((line, index) => ({
      key: `${line.operationId}:${index}`,
      operationId: line.operationId,
      bundleId: line.bundleId ?? '',
      good: String(line.good),
      defective: String(line.defective),
      scrapped: String(line.scrapped),
      reason: line.reason ?? '',
    })),
    returns: Object.fromEntries(prefill.returns.map((row) => [returnKey(row), { quantity: plain(row.quantity), toLocationId: '' }])),
    note: prefill.note ?? base.note,
    returnNoticeId: prefill.returnNoticeId,
  }
}

/** "12.6000" → "12.6". */
export function plain(quantity: string): string {
  if (!quantity.includes('.')) return quantity
  return quantity.replace(/0+$/, '').replace(/\.$/, '')
}

/** The scrap reason's words: our catalogue's for the standard codes, else the code. */
export const scrapReasonKey = (code: string): string => `scrap.${code}`
export const STANDARD_SCRAP = ['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'] as const

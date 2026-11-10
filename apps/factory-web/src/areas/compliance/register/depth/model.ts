import { RECALL_LIMITS } from '@nexus/factory-domain/compliance/recall/rules'
import type {
  AuthorityChannel,
  AuthorityNotice,
  AuthorityRequest,
  DistributorNotice,
  DistributorStatus,
  NoticeDecision,
  ProgressRow,
  PublicWords,
  RecallDetail,
  RecallKind,
  RecallRow,
  Recipients,
  RequestDueState,
  Surveillance,
} from './api'

/**
 * The register in depth without React or the API (B-W2b-271; design compliance.register W2b parts: Register entry ›
 * Authority notices, pop:rg-notice, pop:rg-recall, tab:rg-notice-pdf, the Actions tab's distributor log and recall
 * progress). What a person may do and why not (message keys of `compliance-register-depth`), what each form sends, the
 * builder's primary, the progress in numbers, the language a notice is read in, and the addresses of the new pages.
 * Never a person's figure, never a price: garment counts, days, codes and the person's own words.
 */

// ---- who may do what ------------------------------------------------------------------------------------------------------

export const DEPTH_PERMISSIONS = {
  registerView: 'compliance.register.view',
  registerManage: 'compliance.register.manage',
  recallManage: 'compliance.recall.manage',
  recallSend: 'compliance.recall.send',
  marketsView: 'compliance.certificates.view',
  holdsPlace: 'quality.holds.place',
  techfilesManage: 'compliance.techfiles.manage',
  filesUpload: 'files.upload',
} as const

export type DepthAbility = keyof typeof DEPTH_PERMISSIONS
export type DepthCan = Readonly<Record<DepthAbility, boolean>>

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(DEPTH_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as DepthCan
}

/** The entry as the depth parts read it (W1's entry or the surveillance's). */
export interface EntryFacts {
  readonly id: string
  readonly companyId: string
  readonly reference: string
  readonly status: 'OPEN' | 'CLOSED'
  readonly risk: 'NO' | 'ASSESSING' | 'YES'
  readonly styleId: string
  readonly batchNumbers: readonly string[]
}

// ---- authority notices (pop:rg-notice) --------------------------------------------------------------------------------------

export type NoticeAction = 'draft' | 'edit' | 'send' | 'reference' | 'cancel'

/**
 * Why a notice action is held (a message key), or null: the right first (manage, or send with its fresh code), then the
 * entry (a closed entry gets no new notice), then the notice's state (only a DRAFT is edited, sent or cancelled; a SENT one
 * takes its reference and copy once each), then the law (a RISK notice only once the entry's risk is yes).
 */
export function noticeHeld(action: NoticeAction, notice: Pick<AuthorityNotice, 'status' | 'decision' | 'reference' | 'file'> | null, entry: Pick<EntryFacts, 'status' | 'risk'>, can: Pick<DepthCan, 'recallManage' | 'recallSend'>): string | null {
  if (action === 'send' ? !can.recallSend : !can.recallManage) return action === 'send' ? 'held.send' : 'held.manage'
  if (action === 'draft') return entry.status === 'OPEN' ? null : 'held.entryClosed'
  if (!notice) return 'held.noNotice'
  if (action === 'reference') {
    if (notice.status !== 'SENT') return 'held.notSent'
    return notice.reference && notice.file ? 'held.referenceDone' : null
  }
  if (notice.status !== 'DRAFT') return notice.status === 'SENT' ? 'held.alreadySent' : 'held.cancelled'
  if (entry.status !== 'OPEN' && action !== 'cancel') return 'held.entryClosed'
  if (action === 'send' && notice.decision === 'RISK' && entry.risk !== 'YES') return 'held.riskNotDecided'
  return null
}

export interface NoticeDraftForm {
  readonly marketCode: string
  readonly authorityName: string
  readonly channel: AuthorityChannel
  readonly decision: NoticeDecision
}

/** The decision a new notice starts with: RISK when the entry's risk is yes (the API's default too). */
export const defaultDecision = (risk: EntryFacts['risk']): NoticeDecision => (risk === 'YES' ? 'RISK' : 'NOT_CONFORMING')

export const blankNotice = (entry: Pick<EntryFacts, 'risk'>, marketCode = ''): NoticeDraftForm => ({ marketCode, authorityName: '', channel: 'SAFETY_BUSINESS_GATEWAY', decision: defaultDecision(entry.risk) })

const MARKET = /^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/

/** What stops a new notice, as message keys (all at once; the first holds the button). */
export function noticeDraftProblems(form: NoticeDraftForm, entry: Pick<EntryFacts, 'risk'>): string[] {
  const problems: string[] = []
  if (!MARKET.test(form.marketCode.trim())) problems.push('notice.problem.market')
  if (!form.authorityName.trim()) problems.push('notice.problem.authority')
  else if (form.authorityName.trim().length > RECALL_LIMITS.authorityName) problems.push('notice.problem.authorityLong')
  if (form.decision === 'RISK' && entry.risk !== 'YES') problems.push('notice.problem.riskNotDecided')
  return problems
}

/** What a changed notice sends (only what differs from the notice read; the words per language as typed). */
export function noticeEdit(notice: Pick<AuthorityNotice, 'authorityName' | 'channel' | 'decision' | 'words'>, form: { authorityName: string; channel: AuthorityChannel; decision: NoticeDecision; words: Readonly<Record<string, string>> }) {
  const words = Object.fromEntries(Object.entries(form.words).map(([language, text]) => [language, text]))
  const wordsChanged = Object.keys(words).length !== Object.keys(notice.words).length || Object.entries(words).some(([language, text]) => notice.words[language] !== text)
  return {
    ...(form.authorityName.trim() !== notice.authorityName ? { authorityName: form.authorityName.trim() } : {}),
    ...(form.channel !== notice.channel ? { channel: form.channel } : {}),
    ...(form.decision !== notice.decision ? { decision: form.decision } : {}),
    ...(wordsChanged ? { words } : {}),
  }
}

/** Why the words cannot be saved (a message key), or null: every language has words, none too long. */
export function wordsProblem(words: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(words)
  if (entries.length === 0) return 'notice.problem.noWords'
  if (entries.some(([, text]) => !text.trim())) return 'notice.problem.emptyWords'
  if (entries.some(([, text]) => text.length > RECALL_LIMITS.noticeWords)) return 'notice.problem.wordsLong'
  return null
}

/** The first of the reader's languages the words have, else the first they have; null when none. */
export function pickLanguage(languages: readonly string[], chain: readonly string[]): string | null {
  return chain.find((language) => languages.includes(language)) ?? languages[0] ?? null
}

/** The reader's languages: the page's first, then English and Italian. */
export const readerChain = (locale: string): string[] => [...new Set([locale, 'en', 'it'])]

/** Today's business day in Rome as `YYYY-MM-DD`. */
export function romeDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * A day picked in a dialog as the instant the API takes: today → now (a later hour would be "in the future"), another day →
 * 10:00 UTC of that day (inside the business day in Rome). Empty: nothing (the API's own now).
 */
export function dayInstant(day: string, today: string, now: Date = new Date()): string | undefined {
  if (!day) return undefined
  if (day === today) return now.toISOString()
  return `${day}T10:00:00.000Z`
}

export interface SentForm {
  /** The day it was sent ('' = now). */
  readonly day: string
  readonly reference: string
  /** The copy as sent (a file on this device), or none. */
  readonly copyName: string | null
}

/** What stops "Mark notice as sent" in the form (message keys). */
export function sentProblems(form: SentForm, today: string, entryReportedDay: string | null): string[] {
  const problems: string[] = []
  if (form.day && form.day > today) problems.push('notice.problem.sentFuture')
  if (form.day && entryReportedDay && form.day < entryReportedDay) problems.push('notice.problem.sentBeforeReport')
  if (form.reference.trim().length > RECALL_LIMITS.reference) problems.push('notice.problem.referenceLong')
  return problems
}

/** The window page of a notice's PDF (tab:rg-notice-pdf, SCR-329). */
export const NOTICE_PDF_PATH = '/compliance/register/notice'
export const noticePdfAddress = (prefix: string, noticeId: string, language: string | null): string =>
  `${prefix}${NOTICE_PDF_PATH}?notice=${encodeURIComponent(noticeId)}${language ? `&language=${encodeURIComponent(language)}` : ''}`

/** The notices newest first; a cancelled one last. */
export function noticesInOrder(notices: readonly AuthorityNotice[]): AuthorityNotice[] {
  const rank = (notice: AuthorityNotice) => (notice.status === 'CANCELLED' ? 1 : 0)
  return [...notices].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

export const NOTICE_TONE: Record<AuthorityNotice['status'], 'warning' | 'success' | 'neutral'> = { DRAFT: 'warning', SENT: 'success', CANCELLED: 'neutral' }

// ---- authority requests -----------------------------------------------------------------------------------------------------

export const DUE_TONE: Record<RequestDueState, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  OVERDUE: 'danger',
  DUE_TODAY: 'danger',
  DUE_SOON: 'warning',
  OPEN: 'info',
  ANSWERED: 'success',
  CANCELLED: 'neutral',
}

/** Open requests by due day first, then the answered and cancelled ones newest first. */
export function requestsInOrder(requests: readonly AuthorityRequest[]): AuthorityRequest[] {
  return [...requests].sort((a, b) => {
    const openA = a.status === 'OPEN' ? 0 : 1
    const openB = b.status === 'OPEN' ? 0 : 1
    if (openA !== openB) return openA - openB
    if (openA === 0) return a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id)
    return b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id)
  })
}

/** The end of a request's due day in Rome (the Countdown's target): 23:59 local ≈ 22:00 UTC (summer) — the day's last hour. */
export const dueInstant = (dueOn: string): string => `${dueOn}T21:59:00.000Z`

export interface RequestForm {
  readonly authorityName: string
  readonly marketCode: string
  readonly authorityReference: string
  readonly channel: AuthorityChannel
  /** The day it came ('' = today). */
  readonly receivedOn: string
  readonly dueOn: string
  readonly request: string
  /** The entry's batches it asks about (empty: the whole style). */
  readonly batchNumbers: readonly string[]
}

export const blankRequest = (marketCode = ''): RequestForm => ({ authorityName: '', marketCode, authorityReference: '', channel: 'PEC', receivedOn: '', dueOn: '', request: '', batchNumbers: [] })

/** What stops a request from being logged (message keys, all at once). */
export function requestProblems(form: RequestForm, today: string): string[] {
  const problems: string[] = []
  if (!form.authorityName.trim()) problems.push('request.problem.authority')
  if (!MARKET.test(form.marketCode.trim())) problems.push('notice.problem.market')
  if (!form.request.trim()) problems.push('request.problem.text')
  else if (form.request.length > RECALL_LIMITS.requestText) problems.push('request.problem.textLong')
  const received = form.receivedOn || today
  if (received > today) problems.push('request.problem.receivedFuture')
  if (!form.dueOn) problems.push('request.problem.due')
  else if (form.dueOn < received) problems.push('request.problem.dueBeforeReceived')
  return problems
}

export type RequestAction = 'evidence' | 'answer' | 'cancel'

/** Why a request's action is held (a message key), or null. */
export function requestHeld(action: RequestAction, request: Pick<AuthorityRequest, 'status' | 'style' | 'evidence'>, can: Pick<DepthCan, 'recallManage' | 'techfilesManage'>): string | null {
  if (!can.recallManage) return 'held.manage'
  if (request.status !== 'OPEN') return request.status === 'ANSWERED' ? 'held.answered' : 'held.cancelled'
  if (action === 'evidence') {
    if (!request.style) return 'held.noStyle'
    if (request.evidence) return 'held.evidenceNamed'
    if (!can.techfilesManage) return 'held.techfiles'
  }
  return null
}

// ---- recalls and withdrawals (pop:rg-recall) --------------------------------------------------------------------------------

/** The page of a recall (the Builder in page mode, SCR-328). */
export const recallAddress = (prefix: string, recallId: string): string => `${prefix}/compliance/register/recall/${encodeURIComponent(recallId)}`

export const RECALL_TONE: Record<RecallRow['status'], 'warning' | 'info' | 'success' | 'neutral'> = { DRAFT: 'warning', ACTIVE: 'info', CLOSED: 'success', CANCELLED: 'neutral' }

export type RecallAction = 'scope' | 'hold' | 'start' | 'publish' | 'withdrawNotice' | 'progress' | 'close' | 'cancel'

/**
 * Why a recall action is held (a message key), or null. The right first (manage; publishing is "send", with its fresh
 * code; holds also need quality.holds.place), then the recall's state, then what the action needs.
 */
export function recallHeld(action: RecallAction, recall: Pick<RecallDetail, 'status' | 'notice' | 'holdable' | 'trace' | 'progressRows' | 'entry'>, can: Pick<DepthCan, 'recallManage' | 'recallSend' | 'holdsPlace'>): string | null {
  if (action === 'publish' ? !can.recallSend : !can.recallManage) return action === 'publish' ? 'held.send' : 'held.manage'
  if (action === 'hold' && !can.holdsPlace) return 'held.holds'
  const { status } = recall
  if (status === 'CANCELLED') return 'held.recallCancelled'
  switch (action) {
    case 'scope':
      return status === 'CLOSED' ? 'held.recallClosed' : null
    case 'hold':
      if (status === 'CLOSED') return 'held.recallClosed'
      return recall.holdable.workOrders + recall.holdable.serials + recall.holdable.shipments === 0 ? 'held.nothingToHold' : null
    case 'start':
      if (status !== 'DRAFT') return 'held.started'
      if (recall.entry.status !== 'OPEN') return 'held.entryClosed'
      return recall.trace.counts.concerned === 0 ? 'held.noGarments' : null
    case 'publish':
      if (status !== 'ACTIVE') return status === 'DRAFT' ? 'held.startFirst' : 'held.recallClosed'
      return recall.notice.publishedAt ? 'held.published' : null
    case 'withdrawNotice':
      if (!recall.notice.publishedAt) return 'held.notPublished'
      return recall.notice.withdrawnAt ? 'held.noticeDown' : null
    case 'progress':
      if (status !== 'ACTIVE') return status === 'DRAFT' ? 'held.startFirst' : 'held.recallClosed'
      return recall.progressRows.length === 0 ? 'held.noProgressRows' : null
    case 'close':
      return status === 'ACTIVE' ? null : status === 'DRAFT' ? 'held.startFirst' : 'held.recallClosed'
    case 'cancel':
      return status === 'DRAFT' ? null : 'held.started'
  }
}

/** The builder's primary: "Start recall of 126 garments" while DRAFT, "Close" while ACTIVE; nothing once it ended. */
export function recallPrimary(recall: Pick<RecallDetail, 'status' | 'kind' | 'trace' | 'progress'>): { action: 'start' | 'close'; key: string; count: number } | null {
  if (recall.status === 'DRAFT') return { action: 'start', key: recall.kind === 'WITHDRAWAL' ? 'builder.startWithdrawal' : 'builder.startRecall', count: recall.trace.counts.concerned }
  if (recall.status === 'ACTIVE') return { action: 'close', key: recall.kind === 'WITHDRAWAL' ? 'builder.closeWithdrawal' : 'builder.closeRecall', count: recall.progress.unitsStillOut }
  return null
}

export interface ScopeForm {
  readonly wholeStyle: boolean
  readonly batchNumbers: readonly string[]
  readonly serials: readonly string[]
}

export const scopeFormOf = (recall: Pick<RecallDetail, 'scope' | 'serials'>): ScopeForm => ({ wholeStyle: recall.scope.wholeStyle, batchNumbers: recall.scope.batchNumbers, serials: recall.serials })

/** What stops a scope from being saved (message keys); a started recall only widens. */
export function scopeProblems(form: ScopeForm, recall: Pick<RecallDetail, 'status' | 'scope' | 'serials' | 'workOrders' | 'shipments'>): string[] {
  const problems: string[] = []
  const names = form.wholeStyle || form.batchNumbers.length > 0 || form.serials.length > 0 || recall.workOrders.length > 0 || recall.shipments.length > 0
  if (!names) problems.push('scope.problem.nothing')
  if (form.batchNumbers.length > RECALL_LIMITS.batchNumbers) problems.push('scope.problem.tooManyBatches')
  if (form.serials.length > RECALL_LIMITS.serials) problems.push('scope.problem.tooManySerials')
  if (recall.status === 'ACTIVE') {
    if (recall.scope.wholeStyle && !form.wholeStyle) problems.push('scope.problem.narrowed')
    else if (recall.scope.batchNumbers.some((batch) => !form.batchNumbers.includes(batch)) || recall.serials.some((serial) => !form.serials.includes(serial))) problems.push('scope.problem.narrowed')
  }
  return problems
}

/** What a scope change sends: a DRAFT's scope whole (replaced); an ACTIVE one only what was added. */
export function scopeBody(form: ScopeForm, recall: Pick<RecallDetail, 'status' | 'scope' | 'serials'>): { wholeStyle?: boolean; batchNumbers?: string[]; serials?: string[] } {
  if (recall.status === 'DRAFT') return { wholeStyle: form.wholeStyle, batchNumbers: [...form.batchNumbers], serials: [...form.serials] }
  const batches = form.batchNumbers.filter((batch) => !recall.scope.batchNumbers.includes(batch))
  const serials = form.serials.filter((serial) => !recall.serials.includes(serial))
  return {
    ...(form.wholeStyle && !recall.scope.wholeStyle ? { wholeStyle: true } : {}),
    ...(batches.length > 0 ? { batchNumbers: batches } : {}),
    ...(serials.length > 0 ? { serials } : {}),
  }
}

/** Codes typed in a field, split on commas, spaces and new lines, without repeats. */
export function splitCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((code) => code.trim()).filter(Boolean))]
}

export interface ProgressForm {
  readonly returned: string
  readonly repaired: string
  readonly destroyed: string
}

export const progressFormOf = (row: Pick<ProgressRow, 'unitsReturned' | 'unitsRepaired' | 'unitsDestroyed'>): ProgressForm => ({
  returned: String(row.unitsReturned),
  repaired: String(row.unitsRepaired),
  destroyed: String(row.unitsDestroyed),
})

const count = (text: string): number | null => (/^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : null)

/** A row's counts as numbers, or the problem (a message key): whole numbers, never more back than were sent. */
export function progressCounts(form: ProgressForm, sent: number): { counts: { unitsReturned: number; unitsRepaired: number; unitsDestroyed: number }; stillOut: number } | { problem: string } {
  const returned = count(form.returned)
  const repaired = count(form.repaired)
  const destroyed = count(form.destroyed)
  if (returned === null || repaired === null || destroyed === null) return { problem: 'progress.problem.whole' }
  if (returned + repaired + destroyed > sent) return { problem: 'progress.problem.tooMany' }
  return { counts: { unitsReturned: returned, unitsRepaired: repaired, unitsDestroyed: destroyed }, stillOut: sent - returned - repaired - destroyed }
}

/** A progress bar's value: back of sent, as a whole percent; null when nothing was sent (not measurable, never 0 %). */
export function percentBack(summary: Pick<RecallRow['progress'], 'unitsSent' | 'unitsStillOut'>): number | null {
  if (summary.unitsSent === 0) return null
  return Math.floor(((summary.unitsSent - summary.unitsStillOut) * 100) / summary.unitsSent)
}

/** The recalls of an entry: in progress first, then drafts, then the ended ones newest first. */
export function recallsInOrder(recalls: readonly RecallRow[]): RecallRow[] {
  const rank: Record<RecallRow['status'], number> = { ACTIVE: 0, DRAFT: 1, CLOSED: 2, CANCELLED: 3 }
  return [...recalls].sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

export interface PublicNoticeForm {
  readonly words: Readonly<Record<string, PublicWords>>
}

/** What stops the public notice's words (message keys): every language with a one-line title, the problem, what to do, whom to contact. */
export function publicNoticeProblems(words: Readonly<Record<string, PublicWords>>): string[] {
  const problems = new Set<string>()
  const entries = Object.entries(words)
  if (entries.length === 0) problems.add('public.problem.noLanguage')
  for (const [, text] of entries) {
    if (!text.title.trim() || !text.problem.trim() || !text.action.trim() || !text.contact.trim()) problems.add('public.problem.missing')
    if (/[\r\n]/.test(text.title)) problems.add('public.problem.titleLine')
    if (text.title.length > RECALL_LIMITS.title || text.problem.length > RECALL_LIMITS.problem || text.action.length > RECALL_LIMITS.action || text.contact.length > RECALL_LIMITS.contact) problems.add('public.problem.long')
  }
  return [...problems]
}

/** Whether the typed public notice differs from the recall's. */
export function publicNoticeChanged(before: Readonly<Record<string, PublicWords>> | null, after: Readonly<Record<string, PublicWords>>): boolean {
  const old = before ?? {}
  const keys = new Set([...Object.keys(old), ...Object.keys(after)])
  for (const key of keys) {
    const a = old[key]
    const b = after[key]
    if (!a || !b || a.title !== b.title || a.problem !== b.problem || a.action !== b.action || a.contact !== b.contact) return true
  }
  return false
}

/** An empty language of the public notice. */
export const blankWords = (): PublicWords => ({ title: '', problem: '', action: '', contact: '' })

// ---- distributors told (the Actions tab's log; the builder's step 3) ---------------------------------------------------------

export const DISTRIBUTOR_TONE: Record<DistributorStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = { DRAFT: 'warning', SENT: 'info', ANSWERED: 'success', FAILED: 'danger', CANCELLED: 'neutral' }

/** Every notice of the log (the recipients' and the others'), newest first: who, when, how, the answer. */
export function distributorLog(recipients: Pick<Recipients, 'recipients' | 'others'>): DistributorNotice[] {
  const all = [...recipients.recipients.flatMap((recipient) => recipient.notices), ...recipients.others]
  const unique = new Map(all.map((notice) => [notice.id, notice]))
  return [...unique.values()].sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt) || a.id.localeCompare(b.id))
}

/** The DRAFT notices one send would send ("Send to 5 distributors"). */
export const draftsToSend = (recipients: Pick<Recipients, 'recipients' | 'others'>): DistributorNotice[] => distributorLog(recipients).filter((notice) => notice.status === 'DRAFT')

/** The recipients nobody has drafted or told yet (a draft for them is one click). */
export function recipientsToDraft(recipients: Pick<Recipients, 'recipients'>): number {
  return recipients.recipients.filter((recipient) => !recipient.notices.some((notice) => notice.status === 'DRAFT' || notice.status === 'SENT' || notice.status === 'ANSWERED')).length
}

export type DistributorAction = 'draft' | 'send' | 'answer' | 'fail' | 'cancel' | 'edit'

/** Why a distributor action is held (a message key), or null. */
export function distributorHeld(action: DistributorAction, recipients: Pick<Recipients, 'recipients' | 'others'>, notice: Pick<DistributorNotice, 'status'> | null, can: Pick<DepthCan, 'recallManage' | 'recallSend'>, entry: Pick<EntryFacts, 'status'>): string | null {
  if (action === 'send' ? !can.recallSend : !can.recallManage) return action === 'send' ? 'held.send' : 'held.manage'
  if (action === 'draft') {
    if (entry.status !== 'OPEN') return 'held.entryClosed'
    return recipientsToDraft(recipients) === 0 ? 'held.nobodyToDraft' : null
  }
  if (action === 'send') {
    if (entry.status !== 'OPEN') return 'held.entryClosed'
    return draftsToSend(recipients).length === 0 ? 'held.noDrafts' : null
  }
  if (!notice) return 'held.noNotice'
  if (action === 'edit' || action === 'cancel') return notice.status === 'DRAFT' ? null : 'held.notDraftNotice'
  return notice.status === 'SENT' ? null : 'held.notSentNotice'
}

/** The send's results in counts: sent, refused (with each refusal's line, the API's words as data). */
export function sendSummary(results: readonly { sent: boolean; problem: string | null }[]): { sent: number; refused: number } {
  return { sent: results.filter((result) => result.sent).length, refused: results.filter((result) => !result.sent).length }
}

// ---- the entry's W2b parts ------------------------------------------------------------------------------------------------

/** The Authority notices tab's count: notices not cancelled and requests still open. */
export function authorityCount(surveillance: Pick<Surveillance, 'notices' | 'requests'> | null): number | null {
  if (!surveillance) return null
  return surveillance.notices.filter((notice) => notice.status !== 'CANCELLED').length + surveillance.requests.filter((request) => request.status === 'OPEN').length
}

/** The record band's W2b verb: a recall or withdrawal in progress opens; none yet: start one (the kind follows the entry). */
export function recallVerb(entry: { kind: string }, recalls: readonly RecallRow[]): { kind: 'open'; recallId: string; number: string } | { kind: 'start'; recallKind: RecallKind } {
  const live = recallsInOrder(recalls).find((recall) => recall.status === 'ACTIVE' || recall.status === 'DRAFT')
  if (live) return { kind: 'open', recallId: live.id, number: live.number }
  return { kind: 'start', recallKind: entry.kind === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'RECALL' }
}

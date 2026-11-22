import type { CustomerAsk, FileAsk, FileAskWho, OrderFilesRead } from '../model'
// S2 (#1881): the server's refusal list and its words (it + en), the same pure module the API applies.
import { FILE_ASK_REFUSAL_WORDS, FILE_ASK_REFUSALS, refusalWords, type FileAskRefusal } from '@nexus/factory-domain/files/asks'

/**
 * F-OF-201 … F-OF-203 (order FILES tab W2; 10-design §4, §6; 13-backend B-OF-031…033) — "Waiting for files", without a screen: the band's
 * rows in their order, what the band counts and never names, its answer, each row's doors (≤ 3 visible with the ⋯), and the "Ask for a
 * file…" draft — who uploads it, where it lands, what holds it and the body the command takes. Pure: no React, no API. The band shows
 * only once the read sends `asks` (S2); until then there is no band and no "Ask for a file…" (15-steps "the web never waits").
 *
 * Walls (13-backend §4): a priced ask comes with no words for a reader without prices — counted, never a row; an ask the reader does not
 * read (a work order out of reach, body data without the right) is counted (`asksLeftOut`); the floor is named by its team, role or step,
 * never a worker; nothing says who read it.
 */

/** The rows drawn before "Show N more". */
export const ASKS_SHOWN = 5
/** An ask's words, as the API takes them (1-500; the dialog asks 3 at least). */
export const ASK_WORDS = Object.freeze({ min: 3, max: 500 })

/** What the reader may do on the band (the read's `may` when S3 lands, else the session's rights) and the order's state. */
export interface AskAbilities {
  /** tasks.manage + threads.post over the order: "Ask for a file…", chase, change, reassign, cancel, accept. */
  readonly ask: boolean
  /** partners.tasks.manage and a customer: "The customer (portal)". */
  readonly askCustomer: boolean
  /** files.manage: the Accept window's "Share with <customer>" tick. */
  readonly share: boolean
  /** The order is closed or cancelled (L1): "Ask for a file…" held with words. */
  readonly closed: boolean
  /** The reader changes nothing on the page: no act at all (L3). */
  readonly readOnly: boolean
  /** fx5w (W-09): the reader sees prices — without the price grain "This file shows prices" is not offered (a priced ask needs it). */
  readonly prices?: boolean
}

export type AskRow = { readonly kind: 'ask'; readonly ask: FileAsk } | { readonly kind: 'customer'; readonly ask: CustomerAsk }

export interface AsksBand {
  readonly rows: readonly AskRow[]
  /** Counted, never named: priced asks the reader has no words for; asks outside the reader's role. */
  readonly counted: { readonly priced: number; readonly outside: number }
  /** "3 asked · 1 arrived to check · 1 is late · 1 is asked of you" (keys of `file-asks`). */
  readonly answer: readonly { readonly key: string; readonly params: { readonly count: number } }[]
}

/** A priced ask reaches a reader without prices with no words: never a row (counted on the band's line). */
export const namedAsk = (ask: Pick<FileAsk, 'words'>): boolean => ask.words !== null

/** The band's order: what is asked of the reader first, then what arrived, then the most late, then the nearest due day. */
export function askOrder(a: FileAsk, b: FileAsk): number {
  const mine = Number(b.forMe && b.status === 'OPEN') - Number(a.forMe && a.status === 'OPEN')
  if (mine !== 0) return mine
  const arrived = Number(b.status === 'ARRIVED') - Number(a.status === 'ARRIVED')
  if (arrived !== 0) return arrived
  if (a.lateDays !== b.lateDays) return b.lateDays - a.lateDays
  return a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0
}

/** The band as the read says it; null until the read sends `asks` (S2): no band then. */
export function asksBandOf(read: Pick<OrderFilesRead, 'asks' | 'asksLeftOut' | 'customerAsks'>): AsksBand | null {
  if (!read.asks) return null
  const named = read.asks.filter(namedAsk).sort(askOrder)
  const customer = [...(read.customerAsks ?? [])].sort((a, b) => b.lateDays - a.lateDays || ((a.dueOn ?? '') < (b.dueOn ?? '') ? -1 : 1))
  const rows: AskRow[] = [...named.map((ask) => ({ kind: 'ask' as const, ask })), ...customer.map((ask) => ({ kind: 'customer' as const, ask }))]
  const count = (key: string, n: number) => (n > 0 ? [{ key, params: { count: n } }] : [])
  const answer = [
    ...count('band.answer.asked', named.length),
    ...count('band.answer.arrived', named.filter((ask) => ask.status === 'ARRIVED').length),
    ...count('band.answer.late', named.filter((ask) => ask.lateDays > 0 && ask.status === 'OPEN').length + customer.filter((ask) => ask.lateDays > 0).length),
    ...count('band.answer.mine', named.filter((ask) => ask.forMe && ask.status === 'OPEN').length),
    ...count('band.answer.portal', customer.length),
  ]
  return { rows, counted: { priced: read.asks.length - named.length, outside: read.asksLeftOut ?? 0 }, answer }
}

/** The rows drawn: the first five, or all of them once "Show N more" is open. */
export const shownRows = (rows: readonly AskRow[], open: boolean): { readonly shown: readonly AskRow[]; readonly more: number } => (open || rows.length <= ASKS_SHOWN ? { shown: rows, more: 0 } : { shown: rows.slice(0, ASKS_SHOWN), more: rows.length - ASKS_SHOWN })

/** A floor ask (a team, a floor role, whoever works a step): it lands on a work order, never priced, never body data. */
export const FLOOR_WHO: readonly AskWhoKind[] = ['FLOOR_TEAM', 'FLOOR_ROLE', 'STEP']
export const floorWho = (who: AskWhoKind): boolean => FLOOR_WHO.includes(who)

// ---- F-OF-203: each row's doors (≤ 3 visible with the ⋯; a right missing hides a door; the state holds one with words) ----------------
export type AskDoor = 'accept' | 'again' | 'upload' | 'chase' | 'check' | 'change' | 'reassign' | 'cancel' | 'uploadFor' | 'copyLink'
export interface AskDoorsOf {
  readonly buttons: readonly { readonly door: AskDoor; readonly held: string | null }[]
  readonly menu: readonly { readonly door: AskDoor; readonly held: string | null }[]
}

/**
 * The doors of one ask for this reader (10-design §4 "Buttons"): arrived → Accept… (held while a sent file is being scanned) · Ask again…;
 * open and asked of the reader → Upload for this ask; open, asked of others → Ask for an update. The ⋯ holds Change… · Reassign… ·
 * Cancel the ask… · Upload for this ask — for {who}… · Open what arrived · Copy link. Read-only: the ⋯ with Copy link only.
 */
export function askDoorsOf(ask: Pick<FileAsk, 'status' | 'forMe' | 'answered' | 'may'>, can: Pick<AskAbilities, 'readOnly'>): AskDoorsOf {
  if (can.readOnly) return { buttons: [], menu: [{ door: 'copyLink', held: null }] }
  const buttons: { door: AskDoor; held: string | null }[] = []
  const menu: { door: AskDoor; held: string | null }[] = []
  if (ask.status === 'ARRIVED') {
    if (ask.may.decide) {
      buttons.push({ door: 'accept', held: (ask.answered?.held ?? 0) > 0 ? 'held.checking' : null }, { door: 'again', held: null })
      menu.push({ door: 'check', held: null })
    } else buttons.push({ door: 'check', held: null })
    if (ask.may.change) menu.push({ door: 'cancel', held: null })
  } else {
    if (ask.forMe && ask.may.answer) buttons.push({ door: 'upload', held: null })
    else if (ask.may.change) buttons.push({ door: 'chase', held: null })
    if (ask.may.change) menu.push({ door: 'change', held: null }, { door: 'reassign', held: null }, { door: 'cancel', held: null })
    if (!ask.forMe && ask.may.answer) menu.push({ door: 'uploadFor', held: null })
  }
  menu.push({ door: 'copyLink', held: null })
  return { buttons: buttons.slice(0, 2), menu }
}

// ---- F-OF-202: the "Ask for a file…" draft ------------------------------------------------------------------------------------------
export type AskWhoKind = FileAskWho | 'CUSTOMER'
export type AskWhere = 'SALES_ORDER' | 'SALES_ORDER_LINE' | 'WORK_ORDER'
export type AskFileKind = 'DOCUMENT' | 'PHOTO' | 'ATTACHMENT'
export const ASK_FILE_KINDS: readonly AskFileKind[] = ['DOCUMENT', 'PHOTO', 'ATTACHMENT']
export const ASK_WHO: readonly AskWhoKind[] = ['PERSON', 'OFFICE_ROLE', 'FLOOR_TEAM', 'FLOOR_ROLE', 'STEP', 'CUSTOMER']
export const ASK_WHERE: readonly AskWhere[] = ['SALES_ORDER', 'SALES_ORDER_LINE', 'WORK_ORDER']

export interface AskDraft {
  readonly words: string
  readonly fileKind: AskFileKind
  readonly who: AskWhoKind
  /** The person's, the role's or the team's id (null: none picked; a step and the customer need none). */
  readonly pick: string | null
  readonly where: AskWhere
  readonly lineId: string | null
  readonly workOrderId: string | null
  readonly stepId: string | null
  readonly dueOn: string
  readonly priced: boolean
  readonly bodyData: boolean
}

/** A list the dialog picks from: still read, read, not read (try again), or not for this reader (its kind hidden: a right missing). */
export interface AskList<T> {
  readonly state: 'reading' | 'ready' | 'failed' | 'hidden'
  readonly items: readonly T[]
}

/** What the dialog picks from: the people and roles who may be asked, the teams of the work order's site, its steps, the lines, the work orders. */
export interface AskChoices {
  readonly people: AskList<{ readonly id: string; readonly name: string }>
  /** fx5w (W-08, fx5s): `reach` — how many office people with the role reach this order (absent: not said). */
  readonly officeRoles: AskList<{ readonly id: string; readonly name: string; readonly reach?: number }>
  readonly floorRoles: AskList<{ readonly id: string; readonly name: string }>
  readonly teams: AskList<{ readonly id: string; readonly name: string }>
  readonly steps: AskList<{ readonly id: string; readonly seq: number; readonly name: string }>
  readonly lines: readonly { readonly id: string; readonly seq: number; readonly what: string | null }[]
  /** fx5w (W-04, fx5s): `status` — the work order's (absent: every one offered, as before). */
  readonly workOrders: readonly { readonly id: string; readonly number: string; readonly siteId: string | null; readonly status?: string | null }[]
  /** S3 (B-OF-035): a list of the choices read was cut short (said in words under the picker). */
  readonly truncated?: boolean
}

/** A new ask: a document, asked of a person, landing on the order, due in three days. */
export function newAskDraft(dueOn: string): AskDraft {
  return { words: '', fileKind: 'DOCUMENT', who: 'PERSON', pick: null, where: 'SALES_ORDER', lineId: null, workOrderId: null, stepId: null, dueOn, priced: false, bodyData: false }
}

/** The kinds of "Who uploads it" this reader is offered: a list the reader may not read hides its kind (a right missing). */
export function whoKindsOf(choices: Pick<AskChoices, 'people' | 'officeRoles' | 'floorRoles' | 'teams'> & Partial<Pick<AskChoices, 'steps'>>, can: Pick<AskAbilities, 'askCustomer'>): readonly AskWhoKind[] {
  return ASK_WHO.filter((kind) => {
    if (kind === 'PERSON') return choices.people.state !== 'hidden'
    if (kind === 'OFFICE_ROLE') return choices.officeRoles.state !== 'hidden'
    if (kind === 'FLOOR_ROLE') return choices.floorRoles.state !== 'hidden'
    if (kind === 'FLOOR_TEAM') return choices.teams.state !== 'hidden'
    if (kind === 'STEP') return choices.steps?.state !== 'hidden' // a work order's steps the reader may not read (workorders.view)
    if (kind === 'CUSTOMER') return can.askCustomer
    return true
  })
}

/** Why a kind of "Who" is held by the order's state (a key of `file-asks`), or null: a floor ask needs a work order. */
export const whoHeld = (who: AskWhoKind, choices: Pick<AskChoices, 'workOrders'>): string | null => (floorWho(who) && workOrdersFor(choices.workOrders, true).length === 0 ? 'ask.noWorkOrder' : null)

/** "Where it goes" for this "Who": a floor ask holds the order and a line with words (it always lands on a work order); the customer's is the order. */
export function wheresOf(who: AskWhoKind, choices: Pick<AskChoices, 'lines' | 'workOrders'>): readonly { readonly where: AskWhere; readonly held: string | null }[] {
  if (who === 'CUSTOMER') return [{ where: 'SALES_ORDER', held: null }]
  return ASK_WHERE.filter((where) => (where === 'SALES_ORDER_LINE' ? choices.lines.length > 0 : where === 'WORK_ORDER' ? workOrdersFor(choices.workOrders, floorWho(who)).length > 0 : true)).map((where) => ({ where, held: floorWho(who) && where !== 'WORK_ORDER' ? 'ask.floorWhere' : null }))
}

/** A new "Who": a floor ask moves to a work order (the first, when none is picked), with no prices and no body data; the pick starts again. */
export function withWho(draft: AskDraft, who: AskWhoKind, choices: Pick<AskChoices, 'workOrders'>): AskDraft {
  const next: AskDraft = { ...draft, who, pick: null }
  if (who === 'CUSTOMER') return { ...next, where: 'SALES_ORDER', lineId: null, workOrderId: null, stepId: null, priced: false, bodyData: false }
  // fx5w (W-04): the work order kept only when the new "who" may land on it (a floor ask: released and not finished).
  const kept = draft.workOrderId && workOrdersFor(choices.workOrders, floorWho(who)).some((one) => one.id === draft.workOrderId) ? draft.workOrderId : null
  if (!floorWho(who)) return draft.where === 'WORK_ORDER' && !kept ? { ...next, workOrderId: workOrdersFor(choices.workOrders, false)[0]?.id ?? null, stepId: null } : next
  return { ...next, where: 'WORK_ORDER', workOrderId: kept ?? workOrdersFor(choices.workOrders, true)[0]?.id ?? null, stepId: kept ? draft.stepId : null, priced: false, bodyData: false }
}

/** fx5w (W-04): a floor ask lands only on a work order the floor works now — released, in progress or on hold (never a draft, done or closed). */
export const FLOOR_WORK_ORDER_STATUSES: readonly string[] = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD']
/**
 * The work orders an ask may land on (fx5w W-04, the choices' `status`, fx5s): a floor "who" — released and not finished; an office "who"
 * — every one but a cancelled or closed one. Without the status (before the server sends it) every one is offered, as before.
 */
export function workOrdersFor<T extends { readonly status?: string | null }>(list: readonly T[], floor: boolean): T[] {
  return list.filter((one) => !one.status || (floor ? FLOOR_WORK_ORDER_STATUSES.includes(one.status) : one.status !== 'CANCELLED' && one.status !== 'CLOSED'))
}

/** Why the ask cannot be sent yet (a key of `file-asks`), or null. */
export function askDraftHeld(draft: AskDraft): string | null {
  const words = draft.words.trim().length
  if (draft.who !== 'CUSTOMER' && (words < ASK_WORDS.min || words > ASK_WORDS.max)) return 'ask.held.words'
  if ((draft.who === 'PERSON' || draft.who === 'OFFICE_ROLE' || draft.who === 'FLOOR_ROLE' || draft.who === 'FLOOR_TEAM') && !draft.pick) return 'ask.held.pick'
  if ((draft.where === 'SALES_ORDER_LINE' && !draft.lineId) || (draft.where === 'WORK_ORDER' && !draft.workOrderId)) return 'ask.held.where'
  if (draft.who === 'STEP' && !draft.stepId) return 'ask.held.step'
  if (draft.who !== 'CUSTOMER' && !draft.dueOn) return 'ask.held.due'
  return null
}

/** The `who` the commands take (B-OF-031): one addressee — a person, a role or a team by id; a step needs none (its step is the target's). */
export function whoBody(who: FileAskWho, pick: string | null): Record<string, string> {
  if (who === 'PERSON') return { kind: who, userId: pick ?? '' }
  if (who === 'OFFICE_ROLE' || who === 'FLOOR_ROLE') return { kind: who, roleId: pick ?? '' }
  if (who === 'FLOOR_TEAM') return { kind: who, teamId: pick ?? '' }
  return { kind: who }
}

/** POST /sales/orders/:orderId/file-asks — the body (B-OF-031); never a "who sees it" (the file keeps its upload's audience). */
export function askBody(draft: AskDraft & { readonly who: FileAskWho }): Record<string, unknown> {
  const target =
    draft.where === 'SALES_ORDER_LINE'
      ? { type: draft.where, lineId: draft.lineId }
      : draft.where === 'WORK_ORDER'
        ? { type: draft.where, workOrderId: draft.workOrderId, ...(draft.stepId ? { operationId: draft.stepId } : {}) }
        : { type: draft.where }
  return { words: draft.words.trim(), fileKind: draft.fileKind, target, who: whoBody(draft.who, draft.pick), dueOn: draft.dueOn, ...(draft.priced ? { priced: true } : {}), ...(draft.bodyData ? { bodyData: true } : {}) }
}

/** The kinds a reassign offers: an office ask stays with the office; a floor ask stays on its work order (a step only when it names one). */
export function reassignKindsOf(ask: Pick<FileAsk, 'who' | 'lands'>, choices: Pick<AskChoices, 'people' | 'officeRoles' | 'floorRoles' | 'teams'>): readonly FileAskWho[] {
  const floor = ask.who.kind === 'FLOOR_TEAM' || ask.who.kind === 'FLOOR_ROLE' || ask.who.kind === 'STEP'
  const kinds = (floor ? ['FLOOR_TEAM', 'FLOOR_ROLE', ...(ask.lands.step ? ['STEP' as const] : [])] : ['PERSON', 'OFFICE_ROLE']) as FileAskWho[]
  return kinds.filter((kind) => whoKindsOf(choices, { askCustomer: false }).includes(kind))
}

// ---- F-OF-203: the ask's windows -----------------------------------------------------------------------------------------------------
/** The window open on the band (one at a time), with what it holds; the container keeps it, the body draws it. */
export type AskWindow =
  | { readonly kind: 'ask'; readonly draft: AskDraft }
  | { readonly kind: 'accept'; readonly askId: string; readonly share: boolean }
  | { readonly kind: 'again'; readonly askId: string; readonly reason: string; readonly dueOn: string }
  | { readonly kind: 'chase'; readonly askId: string }
  | { readonly kind: 'reassign'; readonly askId: string; readonly who: FileAskWho; readonly pick: string | null; readonly reason: string }
  | { readonly kind: 'change'; readonly askId: string; readonly words: string; readonly dueOn: string }
  | { readonly kind: 'cancel'; readonly askId: string; readonly reason: string }

/** Why a reason is held (Ask again, Cancel: 3-500; Reassign's is optional, at most 500), or null. */
export const reasonHeld = (reason: string, required: boolean): string | null => {
  const length = reason.trim().length
  return (required && length < ASK_WORDS.min) || length > ASK_WORDS.max ? 'win.why.held' : null
}

/** Why a window's send is held (a key of `file-asks`), or null. */
export function windowHeld(window: AskWindow, ask: Pick<FileAsk, 'answered'> | null): string | null {
  if (window.kind === 'ask') return askDraftHeld(window.draft)
  if (window.kind === 'accept') return (ask?.answered?.held ?? 0) > 0 ? 'held.checking' : null
  if (window.kind === 'again') return reasonHeld(window.reason, true) ?? (window.dueOn ? null : 'ask.held.due')
  if (window.kind === 'cancel') return reasonHeld(window.reason, true)
  if (window.kind === 'reassign') return (window.who !== 'STEP' && !window.pick ? 'ask.held.pick' : null) ?? reasonHeld(window.reason, false)
  if (window.kind === 'change') return window.words.trim().length < ASK_WORDS.min || window.words.trim().length > ASK_WORDS.max ? 'ask.held.words' : window.dueOn ? null : 'ask.held.due'
  return null
}

/** The commands' bodies (B-OF-031): every one at the ask's version. */
export function windowBody(window: AskWindow, ask: Pick<FileAsk, 'version'>): Record<string, unknown> {
  switch (window.kind) {
    case 'again':
      return { version: ask.version, reason: window.reason.trim() }
    case 'cancel':
      return { version: ask.version, reason: window.reason.trim() }
    case 'reassign':
      return { version: ask.version, who: whoBody(window.who, window.pick), ...(window.reason.trim() ? { reason: window.reason.trim() } : {}) }
    case 'change':
      return { version: ask.version, words: window.words.trim(), dueOn: window.dueOn }
    default:
      return { version: ask.version }
  }
}

/**
 * A refusal of the ask commands in words (S2 #1881: the code in the issue path `fileAsk/<CODE>`; state refusals 409, the floor's shape 400).
 * The server's own words: in English as it sent them (a person's name, a count filled in); in Italian from the same list
 * (factory-domain files/asks), with the name or count read back from the English. No code: the kind's words, or the API's.
 */
export function askRefusalOf(error: { readonly kind: string; readonly code: string | null; readonly detail: string | null } | null, locale: 'it' | 'en' = 'en'): { readonly key: string; readonly params?: Readonly<Record<string, string>> } {
  if (!error) return { key: 'refusal.failed' }
  if (error.code && isAskRefusal(error.code)) return { key: 'refusal.server', params: { words: serverWords(error.code, error.detail, locale) } }
  if (error.kind === 'forbidden') return { key: 'refusal.forbidden' }
  if (error.kind === 'not_found') return { key: 'refusal.notFound' }
  if (error.kind === 'conflict' && !error.detail) return { key: 'refusal.stale' }
  if ((error.kind === 'invalid' || error.kind === 'conflict') && error.detail) return { key: 'refusal.words', params: { detail: error.detail } }
  return { key: 'refusal.failed' }
}

export const isAskRefusal = (code: string): code is FileAskRefusal => (FILE_ASK_REFUSALS as readonly string[]).includes(code)

/** The server's words for a refusal in this language: its English as sent; its Italian with the name or count read back from the English. */
export function serverWords(code: FileAskRefusal, english: string | null, locale: 'it' | 'en'): string {
  if (locale === 'en' && english) return english
  const template = FILE_ASK_REFUSAL_WORDS[code].en
  const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{name}', '(?<name>.+?)').replace('{n}', '(?<n>\\d+)').replace('{file}', '(?:files are|file is)')}$`)
  const found = english ? pattern.exec(english)?.groups : undefined
  const n = found?.n !== undefined ? Number(found.n) : undefined
  return refusalWords(code, { ...(found?.name !== undefined ? { name: found.name } : {}), ...(n !== undefined ? { n } : {}) })[locale]
}

/** A day `days` after `day` (both YYYY-MM-DD, the calendar's: no time zone moves it). */
export function dayAfter(day: string, days: number): string {
  const at = Date.parse(`${day}T12:00:00Z`)
  if (Number.isNaN(at)) return day
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10)
}

/** What the band holds besides the read: what the reader may do, the open window, its picks, a refusal or a notice (keys of `file-asks`). */
export interface AsksState {
  readonly can: AskAbilities
  readonly window: AskWindow | null
  readonly choices: AskChoices
  readonly busy: boolean
  readonly problem: { readonly key: string; readonly params?: Readonly<Record<string, string>> } | null
  readonly notice: { readonly key: string; readonly params?: Readonly<Record<string, string>> } | null
  /** `?tab=files&ask=<id>`: the row to mark and bring into view. */
  readonly focus?: string | null
  readonly today: string
}

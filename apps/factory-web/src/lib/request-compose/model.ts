import { PORTAL_REQUEST_LIMITS, requestTextOf, subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'

/**
 * The request written like an e-mail (B-TH-220; threads plan P-CUS-NEW, Owner ask "exactly like an email"), pure: what the
 * compose holds, what holds Send (in words, keys of `request-compose`), the body the API takes — never a party or a company:
 * the portal's session is ONE company and ONE customer (W11), and the office's New request (B-TH-221) adds its own picker —,
 * the subject that will be used, the counter near the end of the box, the optional details' summary line, the draft kept on
 * this device (B-TH-287: the portal's New order also keeps it on the server, ./server-draft.ts), and the guard against sending the same words twice. Shared by
 * the portal's New order and the office's New request: no office or portal code here (check-view-boundaries).
 */

export const COMPOSE_NS = 'request-compose'

export const COMPOSE_LIMITS = Object.freeze({ subject: PORTAL_REQUEST_LIMITS.subject, message: PORTAL_REQUEST_LIMITS.message, customerRef: PORTAL_REQUEST_LIMITS.customerRef })

/** The counter shows from 90 % of the box's limit (P-CUS-NEW.message-F01: "a counter near the end"). */
export const COUNTER_FROM = 0.9

export interface ComposeDraft {
  subject: string
  message: string
  customerRef: string
  /** `YYYY-MM-DD`, or ''. */
  wantedDate: string
  /** One of the customer's own delivery addresses, or '' (the usual one: we ask when we confirm). */
  shipToAddressId: string
}

export const EMPTY_COMPOSE: ComposeDraft = Object.freeze({ subject: '', message: '', customerRef: '', wantedDate: '', shipToAddressId: '' })

export type ComposeField = keyof ComposeDraft

/** Something was typed (a draft worth keeping). */
export const typedIn = (draft: ComposeDraft): boolean => (Object.keys(EMPTY_COMPOSE) as ComposeField[]).some((field) => draft[field].trim() !== '')

/** The subject the request will carry: the one typed, else the message's first line (at most 200 characters, "…"). */
export const subjectUsed = (draft: Pick<ComposeDraft, 'subject' | 'message'>): string => subjectOf(draft.subject, draft.message)

/** The characters the request holds (its subject, when typed, is its first line): what the limit counts. */
export const requestLength = (draft: Pick<ComposeDraft, 'subject' | 'message'>): number => requestTextOf(draft.subject, draft.message).length

/** The box's limit when the counter shows (from 90 %), else null (no counter). */
export const counterLimit = (draft: Pick<ComposeDraft, 'subject' | 'message'>): number | null => (requestLength(draft) >= COMPOSE_LIMITS.message * COUNTER_FROM ? COMPOSE_LIMITS.message : null)

/** A field's problem (a key of `request-compose`), or null. Checked as the API checks it (factory-domain portal-requests). */
export function fieldProblem(field: ComposeField, draft: ComposeDraft, today: string): string | null {
  if (field === 'message' && requestLength(draft) > COMPOSE_LIMITS.message) return 'problem.tooLong'
  if (field === 'customerRef' && draft.customerRef.trim().length > COMPOSE_LIMITS.customerRef) return 'problem.refLong'
  if (field === 'wantedDate' && draft.wantedDate !== '' && draft.wantedDate < today) return 'problem.datePast'
  return null
}

export const COMPOSE_FIELDS: readonly ComposeField[] = ['subject', 'message', 'customerRef', 'wantedDate', 'shipToAddressId']

/** Every field with a problem now. */
export function problemsOf(draft: ComposeDraft, today: string): Partial<Record<ComposeField, string>> {
  const out: Partial<Record<ComposeField, string>> = {}
  for (const field of COMPOSE_FIELDS) {
    const problem = fieldProblem(field, draft, today)
    if (problem) out[field] = problem
  }
  return out
}

export interface SendFacts {
  /** An office person looking at the portal: read-only (P-CUS-NEW.head, state "preview"). */
  preview: boolean
  offline: boolean
  sending: boolean
  /** The company takes no request now (B-TH-012); null while unknown. */
  closed: boolean
}

/** Why Send cannot go now (a key of `request-compose`), or null. Held, never hidden: the button says why. */
export function sendHeld(draft: ComposeDraft, today: string, facts: SendFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (facts.closed) return 'held.closed'
  if (facts.sending) return 'held.sending'
  if (facts.offline) return 'held.offline'
  if (draft.message.trim() === '') return 'held.empty'
  if (Object.keys(problemsOf(draft, today)).length > 0) return 'held.problems'
  return null
}

/** What POST /portal/inquiries takes: what was typed, blanks left out. Never a party, a company or a person (W11). */
export interface ComposeBody {
  subject?: string
  message: string
  customerRef?: string
  wantedDate?: string
  shipToAddressId?: string
}

export function sendBodyOf(draft: ComposeDraft): ComposeBody {
  const body: ComposeBody = { message: draft.message.replace(/\s+$/, '') }
  if (draft.subject.trim() !== '') body.subject = draft.subject.trim()
  if (draft.customerRef.trim() !== '') body.customerRef = draft.customerRef.trim()
  if (draft.wantedDate !== '') body.wantedDate = draft.wantedDate
  if (draft.shipToAddressId !== '') body.shipToAddressId = draft.shipToAddressId
  return body
}

/** The API's refusal at a field (`body/wantedDate`) → that field, or null. */
export function fieldOfIssue(path: string): ComposeField | null {
  const name = path.replace(/^body[/.]/, '')
  return (COMPOSE_FIELDS as readonly string[]).includes(name) ? (name as ComposeField) : null
}

// ── the optional details ─────────────────────────────────────────────────────────────────────────────────────────────
/** One delivery address the customer may name (its own; a new one waits for our check). */
export interface ShipToChoice {
  id: string
  label: string
  waiting: boolean
  isDefault: boolean
}

/** The details typed, for the folded line ("Your PO BA-4521 · wanted by 3 Dec 2026 · to Milano"): null when none. */
export function detailsSummary(draft: ComposeDraft, shipTo: readonly ShipToChoice[], words: { t: (key: string, params?: Readonly<Record<string, string | number>>) => string; day: (iso: string) => string }): string | null {
  const parts: string[] = []
  if (draft.customerRef.trim() !== '') parts.push(words.t('details.sumRef', { ref: draft.customerRef.trim() }))
  if (draft.wantedDate !== '') parts.push(words.t('details.sumDate', { date: words.day(draft.wantedDate) }))
  const address = shipTo.find((choice) => choice.id === draft.shipToAddressId)
  if (address) parts.push(words.t('details.sumShipTo', { place: address.label }))
  return parts.length > 0 ? parts.join(' · ') : null
}

// ── the draft kept on this device (B-TH-287: beside the server's copy, lib/request-compose/server-draft.ts) ──────────────
export const DRAFT_DAYS = 30

export interface KeptCompose {
  readonly draft: ComposeDraft
  readonly savedAt: number
  // ---- B-TH-287: this copy was also saved on the server (a server that keeps none any more: it was sent or discarded elsewhere).
  readonly onServer?: boolean
  // ---- end B-TH-287
}

/** One draft per person and portal (a person may reach two companies' portals: each keeps its own). */
export const composeDraftKey = (personId: string, partyCode: string): string => `factory.portal.request.draft.${personId}.${partyCode}`

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The draft kept on this device, or null (none, too old, unreadable, or storage closed). */
export function readKeptCompose(storage: Pick<Storage, 'getItem'> | null, key: string, now: number): KeptCompose | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (typeof value !== 'object' || value === null || typeof value.savedAt !== 'number') return null
    if (now - value.savedAt > DRAFT_DAYS * 86_400_000) return null
    const draft = (value.draft ?? {}) as Record<string, unknown>
    const kept: ComposeDraft = { subject: text(draft.subject), message: text(draft.message), customerRef: text(draft.customerRef), wantedDate: /^\d{4}-\d{2}-\d{2}$/.test(text(draft.wantedDate)) ? text(draft.wantedDate) : '', shipToAddressId: text(draft.shipToAddressId) }
    // ---- B-TH-287: whether this copy was saved on the server too.
    return typedIn(kept) ? { draft: kept, savedAt: value.savedAt, ...(value.onServer === true ? { onServer: true } : {}) } : null
    // ---- end B-TH-287
  } catch {
    return null
  }
}

/**
 * Keeps the draft on this device (an empty one is forgotten). The answer: what is kept now, `null` when nothing is kept
 * (empty, or no storage: a private window keeps nothing), or `'failed'` when the device refused it.
 */
export function writeKeptCompose(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, key: string, draft: ComposeDraft, now: number, /* B-TH-287 */ onServer = false): KeptCompose | null | 'failed' {
  if (!storage) return null
  try {
    if (!typedIn(draft)) {
      storage.removeItem(key)
      return null
    }
    // ---- B-TH-287: `onServer` — the same words were saved on the server too.
    storage.setItem(key, JSON.stringify(onServer ? { draft, savedAt: now, onServer: true } : { draft, savedAt: now }))
    return onServer ? { draft, savedAt: now, onServer: true } : { draft, savedAt: now }
    // ---- end B-TH-287
  } catch {
    return 'failed'
  }
}

// ── the same words twice (P-CUS-NEW.send-F02) ──────────────────────────────────────────────────────────────────────────
export const SAME_WORDS_MINUTES = 10

export interface LastSent {
  readonly fingerprint: string
  readonly at: number
  /** "Your request 7" (both languages), or null. */
  readonly yours: { readonly it: string; readonly en: string } | null
}

/** The words a request carries, folded (case and spacing do not make it new). */
export const fingerprintOf = (draft: Pick<ComposeDraft, 'subject' | 'message'>): string => requestTextOf(draft.subject, draft.message).replace(/\s+/g, ' ').trim().toLowerCase()

export const lastSentKey = (personId: string, partyCode: string): string => `factory.portal.request.sent.${personId}.${partyCode}`

/** The same words were sent from this device less than 10 minutes ago: when, and as which request (null: not the same). */
export function sameAsLast(draft: Pick<ComposeDraft, 'subject' | 'message'>, last: LastSent | null, now: number): LastSent | null {
  if (!last) return null
  if (now - last.at > SAME_WORDS_MINUTES * 60_000) return null
  return fingerprintOf(draft) === last.fingerprint ? last : null
}

export function readLastSent(storage: Pick<Storage, 'getItem'> | null, key: string): LastSent | null {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value.fingerprint !== 'string' || typeof value.at !== 'number') return null
    const yours = value.yours as Record<string, unknown> | null
    return { fingerprint: value.fingerprint, at: value.at, yours: yours && typeof yours.it === 'string' && typeof yours.en === 'string' ? { it: yours.it, en: yours.en } : null }
  } catch {
    return null
  }
}

export function writeLastSent(storage: Pick<Storage, 'setItem'> | null, key: string, last: LastSent): void {
  try {
    storage?.setItem(key, JSON.stringify(last))
  } catch {
    // A closed storage: the guard simply has nothing to compare with.
  }
}

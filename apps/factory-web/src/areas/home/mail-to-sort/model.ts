/**
 * SCR-019 "Mail to sort" — the pure part (A2 §2.1; features COL-022, COL-023, COL-025, COL-026, COL-078): received mail
 * that no record took (TRIAGE), mail held for a person to look at first (HELD), and mail that could not be read
 * (FAILED). A person assigns a mail to a record (its thread takes it and its files become the record's), releases a held
 * one, or throws one away (spam, or not for us). What each mail allows, what its checks mean, and how its sanitised
 * HTML is shown live here; the view draws them, the container (MailToSort.tsx) fills them, the tests hold them.
 *
 * The API's words are mirrored from @nexus/factory-domain email-in/rules.ts (named per line); an answer that does not
 * match is a `contract` error, never half-read.
 */

/** email-in/rules.ts INBOUND_STATUSES. */
export const INBOUND_STATUSES = ['RECEIVED', 'FETCHED', 'MATCHED', 'TRIAGE', 'HELD', 'REJECTED', 'FAILED'] as const
export type InboundStatus = (typeof INBOUND_STATUSES)[number]
/** email-in/rules.ts TO_SORT: the list's default. */
export const TO_SORT: readonly InboundStatus[] = ['TRIAGE', 'HELD', 'FAILED']
/** email-in/rules.ts MAIL_VERDICTS. */
export const MAIL_VERDICTS = ['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'DISABLED'] as const
export type MailVerdict = (typeof MAIL_VERDICTS)[number]
/** email-in/rules.ts HELD_REASONS (COL-022). */
export const HELD_REASONS = ['DMARC_FAIL', 'SPAM', 'UNKNOWN_SENDER', 'THREAD_CLOSED'] as const
export type HeldReason = (typeof HELD_REASONS)[number]
/** email-in/rules.ts REJECT_REASONS and the two a person gives. */
export const REJECT_REASONS = ['VIRUS', 'DUPLICATE', 'MARKED_SPAM', 'DISCARDED'] as const
export type RejectReason = (typeof REJECT_REASONS)[number]
export const PERSON_REJECT_REASONS = ['MARKED_SPAM', 'DISCARDED'] as const
export type PersonRejectReason = (typeof PERSON_REJECT_REASONS)[number]
/** email-in/rules.ts MATCHED_BY. */
export const MATCHED_BY = ['TOKEN', 'HEADERS', 'SENDER', 'MANUAL'] as const
/** email-in/rules.ts SKIP_REASONS. */
export const SKIP_REASONS = ['type_not_allowed', 'too_large', 'empty', 'inline', 'too_many'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export type MailFilter = 'all' | 'TRIAGE' | 'HELD' | 'FAILED'
export const MAIL_FILTERS: readonly MailFilter[] = ['all', 'TRIAGE', 'HELD', 'FAILED']

export interface Verdicts {
  spf: MailVerdict
  dkim: MailVerdict
  dmarc: MailVerdict
  dmarcPolicy: string | null
  spam: MailVerdict
  virus: MailVerdict
}

export interface MailSummary {
  id: string
  status: InboundStatus
  receivedAt: string
  from: { address: string | null; name: string | null }
  subject: string | null
  excerpt: string
  verdicts: Verdicts
  heldReason: HeldReason | null
  rejectReason: RejectReason | null
  /** The thread it names while it waits (a release writes there). */
  threadId: string | null
  /** A party the sender is (or whose domain it shares): a suggestion only. */
  suggestedPartyId: string | null
  attachmentCount: number
  version: number
}

export interface MailAttachment {
  name: string
  contentType: string
  sizeBytes: number
  kept: boolean
  skipReason: SkipReason | null
  /** The file that holds it, when kept and the reader may see it. */
  fileId: string | null
}

export interface MailDetail extends MailSummary {
  to: readonly string[]
  cc: readonly string[]
  bodyText: string | null
  /** The sanitised HTML (factory-domain email-in/sanitise.ts), or null. */
  bodyHtml: string | null
  attachments: readonly MailAttachment[]
  /** The thread it names, with its record. */
  thread: { recordType: string; recordId: string; status: 'OPEN' | 'CLOSED' } | null
  attempts: number
  fetchedAt: string | null
}

/** A record a mail can be assigned to (found by its number). */
export interface RecordCandidate {
  type: string
  id: string
  /** Its number as people say it ("0000-17092-A"). */
  number: string
  /** What it is, one line ("EN 17092-3 · class A"). */
  title: string
  /** It has a customer, supplier or brand: only then can its thread take mail. */
  hasParty: boolean
}

export interface AssignState {
  /** Null while the records are read. */
  candidates: readonly RecordCandidate[] | null
  /** The read failed (a message key). */
  problem?: string | null
}

export interface Loaded<T> {
  items: readonly T[] | null
  more: boolean
  problem?: string | null
}

export type MailDialog = 'assign' | 'release' | 'reject'

export interface MailToSortViewModel {
  filter: MailFilter
  mails: Loaded<MailSummary>
  /** The mail open in the detail; `detail` null while it is read. */
  open: { id: string; detail: MailDetail | null; problem?: string | null } | null
  /** threads.post: assigning and releasing write the mail into a record's thread. */
  canWrite: boolean
  /** files.read: the mail's kept attachments can be downloaded. */
  canReadFiles: boolean
  /** A dialog over the detail (design fixtures open one at once). */
  dialog?: MailDialog | null
  assign: AssignState
  busy?: boolean
  /** A notice over the list: a message key of the `home` catalogue and its tone. */
  notice?: { key: string; tone: 'success' | 'info' | 'warning' | 'danger' } | null
  /** The detail shows the mail's remote pictures (the person allowed them). */
  showPictures?: boolean
}

export interface MailAction {
  action: MailDialog
  /** Held: why it cannot run now (a message key), or null. */
  held: string | null
}

/**
 * What a person may do with a mail (email-in/rules.ts inboundMachine; triage.ts): TRIAGE → assign or throw away;
 * HELD → release (into the thread it named, else back to the list), assign elsewhere, or throw away; FAILED → throw
 * away only (it was never read). Assign and release write into a record's thread, so they need threads.post. A
 * released DMARC failure is the person's decision: the dialog says so.
 */
export function mailActions(mail: Pick<MailSummary, 'status'>, canWrite: boolean): MailAction[] {
  const write = canWrite ? null : 'mailToSort.held.noWrite'
  switch (mail.status) {
    case 'TRIAGE':
      return [
        { action: 'assign', held: write },
        { action: 'reject', held: null },
      ]
    case 'HELD':
      return [
        { action: 'release', held: write },
        { action: 'assign', held: write },
        { action: 'reject', held: null },
      ]
    case 'FAILED':
      return [{ action: 'reject', held: null }]
    default:
      return []
  }
}

/** Where a released mail goes: into the thread it names, or back to the list to be assigned. */
export function releaseTarget(mail: Pick<MailSummary, 'threadId'>): 'thread' | 'list' {
  return mail.threadId ? 'thread' : 'list'
}

export type MailTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

/** A status as a tag: its words (message key) and tone. */
export function statusLook(mail: Pick<MailSummary, 'status'>): { key: string; tone: MailTone } {
  switch (mail.status) {
    case 'TRIAGE':
      return { key: 'mailToSort.status.TRIAGE', tone: 'info' }
    case 'HELD':
      return { key: 'mailToSort.status.HELD', tone: 'warning' }
    case 'FAILED':
      return { key: 'mailToSort.status.FAILED', tone: 'danger' }
    case 'MATCHED':
      return { key: 'mailToSort.status.MATCHED', tone: 'success' }
    case 'REJECTED':
      return { key: 'mailToSort.status.REJECTED', tone: 'neutral' }
    default:
      return { key: `mailToSort.status.${mail.status}`, tone: 'neutral' }
  }
}

/** The checks to point at: those that failed or found something (SPF, DKIM, DMARC fail; spam or virus found). */
export function verdictWarnings(verdicts: Verdicts): Array<'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus'> {
  const warnings: Array<'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus'> = []
  for (const check of ['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const) if (verdicts[check] === 'FAIL') warnings.push(check)
  return warnings
}

/** How many remote pictures the sanitised HTML holds (each waits in `data-remote-src` until the person allows them). */
export function remotePictureCount(html: string | null): number {
  if (!html) return 0
  return (html.match(/\sdata-remote-src=/gi) ?? []).length
}

/**
 * The document the sandboxed frame shows (COL-026): the sanitised HTML in a page of its own with a strict content
 * security policy (no script, no form, no frame; pictures only when allowed, and then only https ones) and links opened
 * apart. Remote pictures load only when `allowPictures`: their `data-remote-src` becomes `src`. A mail is drawn on the
 * light canvas in both themes (as mail programs do: senders colour their text for white paper). The frame itself is
 * `sandbox` without `allow-scripts` or `allow-same-origin`: the second wall after the API's sanitiser.
 */
export function mailDocument(html: string, options: { allowPictures: boolean }): string {
  const body = options.allowPictures ? html.replace(/\sdata-remote-src=/gi, ' src=') : html
  const images = options.allowPictures ? 'https: data:' : 'data:'
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<style>:root{color-scheme:light}body{margin:0;padding:12px;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>',
    '<base target="_blank">',
    `</head><body>${body}</body></html>`,
  ].join('')
}

/** The sender as one line: "Name <address>", the address alone, or null. */
export function senderLine(from: MailSummary['from']): string | null {
  if (from.name && from.address) return `${from.name} <${from.address}>`
  return from.address ?? from.name ?? null
}

const folded = (text: string) => text.toLowerCase().replace(/[\s\-/._]+/g, '')

/**
 * The records the assign dialog offers for what the person typed (a number, or part of one): only records whose thread
 * can take mail (a party), matched on the number (spaces, hyphens, slashes and dots aside) or the title, numbers that
 * start with it first; at most `max` shown (the rest counted). Nothing typed: the first `max`.
 */
export function matchCandidates(candidates: readonly RecordCandidate[], query: string, max = 8): { shown: RecordCandidate[]; total: number } {
  const wanted = folded(query.trim())
  const scored = candidates
    .filter((candidate) => candidate.hasParty)
    .flatMap((candidate) => {
      if (wanted === '') return [{ candidate, score: 0 }]
      const number = folded(candidate.number)
      if (number.startsWith(wanted)) return [{ candidate, score: 0 }]
      if (number.includes(wanted)) return [{ candidate, score: 1 }]
      if (folded(candidate.title).includes(wanted)) return [{ candidate, score: 2 }]
      return []
    })
    .sort((a, b) => a.score - b.score || a.candidate.number.localeCompare(b.candidate.number, 'en', { numeric: true }))
  return { shown: scored.slice(0, max).map((entry) => entry.candidate), total: scored.length }
}

/** The live message that changes this list: a mail's place was decided (`email.inbound_sorted`, live: email.triage). */
export function isMailChange(change: { type: string }): boolean {
  return change.type === 'email.inbound_sorted'
}

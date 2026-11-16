/**
 * B-TH-207 — know who gets it before it goes (threads plan T7; picture 5, approved 2026-11-17). In a reply, To and Cc sit on one
 * line each, every person with their organisation, so a wrong customer is caught by eye; suggestions are only this record's
 * customer's contacts (W21). Before the mail goes, the send check "Send to <customer>?" names who gets it (from you, with the
 * record's reply address, so the answer lands back here) and every risk the API found — the six warnings of the mis-send read
 * (C18): another organisation, an unknown recipient, money words, another customer's name, a colleague's @mention, an office
 * file. An address of another customer is refused unless "Send outside this customer" is ticked: the API records the tick
 * (B-TH-004, B-TH-202). A failed send keeps the text. Pure; the codes mirror apps/factory-api platform/email-out/mis-send.
 *
 * Not built until the back end has it: Undo send (thread-G08, B-TH-048, TH-3).
 */

export const CHECK_WARNINGS = ['OTHER_ORGANISATION', 'UNKNOWN_RECIPIENT', 'MENTIONS_COST', 'NAMES_OTHER_CUSTOMER', 'INTERNAL_MENTION', 'OFFICE_FILE'] as const
export type CheckWarning = (typeof CHECK_WARNINGS)[number]
export const RECIPIENT_KINDS = ['PARTY', 'OTHER_PARTY', 'OURS', 'UNKNOWN'] as const
export type RecipientKind = (typeof RECIPIENT_KINDS)[number]

/** At most this many addresses in one mail (email-out MAX_RECIPIENTS). */
export const MAX_RECIPIENTS = 50
/** A subject's longest (email-out MAX_SUBJECT_LENGTH). */
export const MAX_SUBJECT = 200

/** The check's answer (POST /threads/<type>/<id>/emails/check). */
export interface SendCheck {
  party: { id: string; name: string } | null
  recipients: ReadonlyArray<{ address: string; kind: RecipientKind; source: string | null; organisation: { id: string; name: string } | null; personName: string | null }>
  warnings: ReadonlyArray<{ code: CheckWarning; items: readonly string[] }>
  attachments: ReadonlyArray<{ id: string; name: string; sizeBytes: number; audience: 'PARTY' | 'OFFICE' }>
  /** The addresses the send refuses without "Send outside this customer" (B-TH-202). */
  outsideCustomer: readonly string[]
}

export type CheckState = { status: 'checking' } | { status: 'ready'; check: SendCheck } | { status: 'error'; problem: string; retry: boolean }

/** One address on the To or Cc line. */
export interface Recipient {
  address: string
  /** The person's name, when a contact or the check knows it. */
  name: string | null
  /** Whose it is: from the check once it ran; a picked contact is the customer's. Null: not known yet. */
  kind: RecipientKind | null
  organisation: string | null
}

/** A contact of the record's customer, for the suggestions. */
export interface Contact {
  name: string
  email: string
}

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/

/** An address as the API takes it (trimmed, lower case, no brackets), or null when it is not one. */
export function cleanAddress(text: string): string | null {
  const address = text.trim().replace(/^<|>$/g, '').toLowerCase()
  return ADDRESS.test(address) && address.length <= 254 ? address : null
}

/**
 * What To suggests while typing (W21): only the record's customer's contacts with an address, not already on the lines, matching
 * the name or the address; a typed address no contact has is offered as it is ("not a contact"): the check names whose it is.
 */
export function suggestions(query: string, contacts: readonly Contact[], taken: readonly string[]): { contacts: Contact[]; free: string | null } {
  const words = query.trim().toLowerCase()
  const shown = contacts.filter((contact) => cleanAddress(contact.email) && !taken.includes(contact.email.toLowerCase()) && (words === '' || `${contact.name} ${contact.email}`.toLowerCase().includes(words)))
  const typed = cleanAddress(query)
  const free = typed && !taken.includes(typed) && !contacts.some((contact) => contact.email.toLowerCase() === typed) ? typed : null
  return { contacts: shown, free }
}

/** A recipient as the check classified it (the chip's colour and its organisation); before the check, as picked. */
export function classify(recipient: Recipient, check: SendCheck | null): Recipient {
  const found = check?.recipients.find((item) => item.address === recipient.address)
  if (!found) return recipient
  return { ...recipient, kind: found.kind, organisation: found.organisation?.name ?? null, name: recipient.name ?? found.personName }
}

/** The chip's words beside a name: the organisation, "another customer", "not a contact", "our colleague". A key and its parameters. */
export function chipWords(recipient: Recipient): { key: string; params?: Record<string, string> } {
  if (recipient.kind === 'OTHER_PARTY') return { key: 'chip.other', params: { org: recipient.organisation ?? '' } }
  if (recipient.kind === 'UNKNOWN') return { key: 'chip.unknown' }
  if (recipient.kind === 'OURS') return { key: 'chip.ours' }
  if (recipient.organisation) return { key: 'chip.org', params: { org: recipient.organisation } }
  return { key: 'chip.checking' }
}

/** Why the reply cannot be checked yet (a key of record-thread-send), or null: no recipient, too many, a subject too long. */
export function recipientsHeld(to: readonly Recipient[], cc: readonly Recipient[], subject: string): { key: string; params?: Record<string, string | number> } | null {
  if (to.length === 0) return { key: 'held.noRecipient' }
  if (to.length + cc.length > MAX_RECIPIENTS) return { key: 'held.tooMany', params: { max: MAX_RECIPIENTS } }
  if ([...subject].length > MAX_SUBJECT) return { key: 'held.subject', params: { max: MAX_SUBJECT } }
  return null
}

/** Warnings that refuse the send as it is (danger): another customer's address without the tick, an office-only file. */
export const BLOCKING: ReadonlySet<CheckWarning> = new Set(['OFFICE_FILE'])

/**
 * Why "Send to <customer>" waits in the check (a key of record-thread-send), or null. A check that could not run does not hold the
 * send (T7-F02: "Could not check", the API still refuses another customer's address); one the person may not run does.
 */
export function confirmHeld(state: CheckState, ticks: { outside: boolean }, sending: boolean): string | null {
  if (sending) return 'check.held.sending'
  if (state.status === 'checking') return 'check.held.checking'
  if (state.status === 'error') return state.retry ? null : 'check.held.refused'
  if (state.check.warnings.some((warning) => warning.code === 'OFFICE_FILE')) return 'check.held.officeFile'
  if (state.check.outsideCustomer.length > 0 && !ticks.outside) return 'check.held.outside'
  return null
}

/** The warnings in the order the picture lists them, each with its words (keys of record-thread-send). */
export function warningLines(check: SendCheck): Array<{ code: CheckWarning; key: string; params: Record<string, string>; blocking: boolean }> {
  return CHECK_WARNINGS.flatMap((code) => {
    const warning = check.warnings.find((item) => item.code === code)
    if (!warning) return []
    return [{ code, key: `warning.${code}`, params: { items: warning.items.join(', '), party: check.party?.name ?? '' }, blocking: BLOCKING.has(code) }]
  })
}

/** The send's body: To and Cc apart, the tick only when it was given (the API records it). */
export function sendBody(input: { to: readonly Recipient[]; cc: readonly Recipient[]; subject: string; body: string; attachments: readonly string[]; outside: boolean }): {
  to: string[]
  cc?: string[]
  subject?: string
  body: string
  attachments: string[]
  sendOutside?: true
} {
  return {
    to: input.to.map((item) => item.address),
    ...(input.cc.length > 0 ? { cc: input.cc.map((item) => item.address) } : {}),
    ...(input.subject.trim() ? { subject: input.subject.trim() } : {}),
    body: input.body,
    attachments: [...input.attachments],
    ...(input.outside ? { sendOutside: true as const } : {}),
  }
}

/** The record's contacts first on To: the first contact with an address fills To when a reply opens with none. */
export function defaultTo(contacts: readonly Contact[], partyName: string | null): Recipient[] {
  const first = contacts.find((contact) => cleanAddress(contact.email))
  return first ? [{ address: first.email.toLowerCase(), name: first.name, kind: 'PARTY', organisation: partyName }] : []
}

/** The subject a reply starts with: "Re: " and the thread's latest mail's, else the record's number. */
export function defaultSubject(lastSubject: string | null, recordLabel: string): string {
  if (lastSubject) return /^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`
  return recordLabel
}

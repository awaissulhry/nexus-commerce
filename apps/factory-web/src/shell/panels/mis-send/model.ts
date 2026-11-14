/**
 * The mis-send guard — the pure part (B-W2b-397; COL-004; design shell.panels pop:mis-send "Send to Pista Racing?", D8
 * ActionConfirm with a held Confirm): before a message to the record's party goes, the person sees each recipient with its
 * organisation, what the API found in the text (cost, another customer, a colleague @mentioned) and who sees each
 * attachment. A mail that went to the wrong customer cannot be taken back, so Send waits while the check runs, when it
 * failed, until the person ticks that they read the warnings, and while an attachment is the office's only (the send would
 * refuse it). The API's codes are mirrored from apps/factory-api platform/email-out/mis-send/rules.ts; an answer that does
 * not match them is a `contract` error, never half-read.
 */

export const MIS_SEND_WARNINGS = ['OTHER_ORGANISATION', 'UNKNOWN_RECIPIENT', 'MENTIONS_COST', 'NAMES_OTHER_CUSTOMER', 'INTERNAL_MENTION', 'OFFICE_FILE'] as const
export type MisSendWarning = (typeof MIS_SEND_WARNINGS)[number]
export const RECIPIENT_KINDS = ['PARTY', 'OTHER_PARTY', 'OURS', 'UNKNOWN'] as const
export type RecipientKind = (typeof RECIPIENT_KINDS)[number]
export const RECIPIENT_SOURCES = ['CONTACT', 'PORTAL_PERSON', 'COLLEAGUE', 'OUR_DOMAIN', 'DOMAIN'] as const
export type RecipientSource = (typeof RECIPIENT_SOURCES)[number]

export interface MisSendRecipient {
  readonly address: string
  readonly kind: RecipientKind
  readonly source: RecipientSource | null
  readonly organisation: { readonly id: string; readonly name: string } | null
  readonly personName: string | null
}

export interface MisSendCheck {
  readonly party: { readonly id: string; readonly name: string } | null
  readonly recipients: readonly MisSendRecipient[]
  readonly warnings: readonly { readonly code: MisSendWarning; readonly items: readonly string[] }[]
  readonly attachments: readonly { readonly id: string; readonly name: string; readonly sizeBytes: number; readonly audience: 'PARTY' | 'OFFICE' }[]
}

/** What the person is about to send, as the composer has it (the To line already split into addresses). */
export interface MisSendDraft {
  readonly to: readonly string[]
  readonly subject: string
  readonly body: string
  readonly attachments: readonly string[]
}

/** The check while it runs, as it came back, or why it could not run (a key of `mail-depth`). */
export type MisSendState = { readonly status: 'checking' } | { readonly status: 'ready'; readonly check: MisSendCheck } | { readonly status: 'error'; readonly problem: string; readonly retry: boolean }

export interface MisSendModel {
  readonly state: MisSendState
  readonly draft: MisSendDraft
  /** The record's party as the panel knows it (the title, before the check answers). */
  readonly partyName: string | null
  /** The send runs (after Send message). */
  readonly sending: boolean
  /** Design cases: the warnings already ticked as read. */
  readonly acknowledged?: boolean
}

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

/** A warning's weight: another organisation among the recipients is the mis-send itself (danger); the rest ask a look. */
export const WARNING_TONE: Readonly<Record<MisSendWarning, Tone>> = {
  OTHER_ORGANISATION: 'danger',
  OFFICE_FILE: 'danger',
  UNKNOWN_RECIPIENT: 'warning',
  MENTIONS_COST: 'warning',
  NAMES_OTHER_CUSTOMER: 'warning',
  INTERNAL_MENTION: 'warning',
}

export const RECIPIENT_TONE: Readonly<Record<RecipientKind, Tone>> = { PARTY: 'success', OTHER_PARTY: 'danger', OURS: 'neutral', UNKNOWN: 'warning' }

/** The words of a recipient's organisation tag: a key and its parameters. */
export function recipientWords(recipient: MisSendRecipient): { key: string; params: Record<string, string> } {
  const name = recipient.organisation?.name ?? ''
  if (recipient.kind === 'PARTY') return { key: recipient.source === 'DOMAIN' ? 'misSend.recipient.partyDomain' : 'misSend.recipient.party', params: { name } }
  if (recipient.kind === 'OTHER_PARTY') return { key: recipient.source === 'DOMAIN' ? 'misSend.recipient.otherDomain' : 'misSend.recipient.other', params: { name } }
  return { key: recipient.kind === 'OURS' ? `misSend.recipient.ours.${recipient.source === 'OUR_DOMAIN' ? 'domain' : 'colleague'}` : 'misSend.recipient.unknown', params: {} }
}

/** The check found something the person must say they read before Send. */
export const needsAcknowledge = (check: MisSendCheck): boolean => check.warnings.some((warning) => warning.code !== 'OFFICE_FILE')

/** Why Send message waits (a key of `mail-depth`), or null when it may go. */
export function sendHeld(model: Pick<MisSendModel, 'state' | 'sending'>, acknowledged: boolean): string | null {
  if (model.sending) return 'misSend.held.sending'
  if (model.state.status === 'checking') return 'misSend.held.checking'
  if (model.state.status === 'error') return model.state.retry ? 'misSend.held.failed' : 'misSend.held.refused'
  const { check } = model.state
  if (check.warnings.some((warning) => warning.code === 'OFFICE_FILE')) return 'misSend.held.officeFile'
  if (needsAcknowledge(check) && !acknowledged) return 'misSend.held.acknowledge'
  return null
}

/** The dialog's title: the party the check names, else the panel's, else a plain question. */
export function titleOf(model: Pick<MisSendModel, 'state' | 'partyName'>): { key: string; params: Record<string, string> } {
  const name = (model.state.status === 'ready' ? model.state.check.party?.name : null) ?? model.partyName
  return name ? { key: 'misSend.title', params: { party: name } } : { key: 'misSend.titlePlain', params: {} }
}

/** Sizes in the person's numbers ("2 KB", "1.4 MB"). */
export const sizeWords = (bytes: number, locale: string): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`

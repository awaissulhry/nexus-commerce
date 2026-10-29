import { domainOf, isAddress } from '@nexus/factory-domain/email/rules'
import type { Loaded, Notice } from '../../shared/model'
import type { DisplayNamePolicy, IdentityKind, IntegrationAccount, SendingIdentity, VerificationStatus } from '../api'

/**
 * SCR-015 Your mail domain (design 02 admin.connections `mail-domain`; PLT-230, COL-020, COL-022): the companies' sending
 * identities, each with the DNS records to add at the registrar and their state, a check that reads SES again, and a
 * new sending domain. Pure: the identity's state, the record rows, the add form's checks.
 *
 * What the API knows (platform/email-out): SES's verification of the domain and of its three DKIM CNAMEs (one state for
 * the three). SPF, DMARC and the MX for replies are not checked by Nexus yet: the rows say so instead of guessing.
 */

/** A sending identity's state in words (`mail.state.<key>`). */
export type IdentityState = 'ready' | 'waiting' | 'failed' | 'disabled'

export function identityState(identity: Pick<SendingIdentity, 'ready' | 'status' | 'verificationStatus' | 'dkimStatus'>): IdentityState {
  if (identity.status === 'DISABLED') return 'disabled'
  if (identity.ready) return 'ready'
  if (identity.verificationStatus === 'FAILED' || identity.dkimStatus === 'FAILED') return 'failed'
  return 'waiting'
}

export const IDENTITY_TONE: Readonly<Record<IdentityState, 'success' | 'info' | 'danger' | 'neutral'>> = { ready: 'success', waiting: 'info', failed: 'danger', disabled: 'neutral' }

/** A DNS record's state (`mail.record.<key>`): found, not found yet, failed, being retried, or not checked by Nexus. */
export type RecordState = 'found' | 'waiting' | 'failed' | 'retrying' | 'notChecked'

export function recordStateOf(status: VerificationStatus): RecordState {
  if (status === 'SUCCESS') return 'found'
  if (status === 'FAILED') return 'failed'
  if (status === 'TEMPORARY_FAILURE') return 'retrying'
  return 'waiting'
}

export const RECORD_TONE: Readonly<Record<RecordState, 'success' | 'info' | 'danger' | 'warning' | 'neutral'>> = { found: 'success', waiting: 'info', failed: 'danger', retrying: 'warning', notChecked: 'neutral' }

/** A row of the DNS table: the type, the name to add at the registrar, the value (null: not given by Nexus yet). */
export interface DnsRow {
  id: string
  type: 'CNAME' | 'TXT' | 'MX'
  /** What it does, `mail.purpose.<key>`. */
  purpose: 'dkim' | 'spf' | 'dmarc' | 'mx'
  name: string
  value: string | null
  state: RecordState
}

/** The records an identity needs: its three DKIM CNAMEs (SES's state), then SPF, DMARC and the reply MX (not checked yet). */
export function dnsRows(identity: SendingIdentity): DnsRow[] {
  const dkim = recordStateOf(identity.dkimStatus)
  return [
    ...identity.dkimRecords.map((record, index) => ({ id: `dkim-${index}`, type: 'CNAME' as const, purpose: 'dkim' as const, name: record.name, value: record.value, state: dkim })),
    { id: 'spf', type: 'TXT', purpose: 'spf', name: identity.domain, value: null, state: 'notChecked' },
    { id: 'dmarc', type: 'TXT', purpose: 'dmarc', name: `_dmarc.${identity.domain}`, value: null, state: 'notChecked' },
    { id: 'mx', type: 'MX', purpose: 'mx', name: identity.replyDomain, value: null, state: 'notChecked' },
  ]
}

/** "Copy all records": the records Nexus gives, one per line, as a registrar takes them (type, name, value). */
export function recordsText(identity: SendingIdentity): string {
  return identity.dkimRecords.map((record) => `${record.type}\t${record.name}\t${record.value}`).join('\n')
}

export interface AddDomainDraft {
  companyId: string
  kind: IdentityKind
  domain: string
  localPart: string
  displayNamePolicy: DisplayNamePolicy
  accountId: string
}

export const emptyDraft = (companyId = '', accountId = ''): AddDomainDraft => ({ companyId, kind: 'CONVERSATION', domain: '', localPart: 'noreply', displayNamePolicy: 'PERSON_VIA_COMPANY', accountId })

/** The add form's problems, as `mail.form.<key>` message keys per field (the API checks the same). */
export function draftProblems(draft: AddDomainDraft): Partial<Record<keyof AddDomainDraft, string>> {
  const out: Partial<Record<keyof AddDomainDraft, string>> = {}
  if (!draft.companyId) out.companyId = 'mail.form.required'
  if (!draft.accountId) out.accountId = 'mail.form.noAccount'
  const domain = domainOf(draft.domain)
  if (draft.domain.trim() === '') out.domain = 'mail.form.required'
  else if (!domain) out.domain = 'mail.form.domain'
  const local = draft.localPart.trim().toLowerCase()
  if (local === '') out.localPart = 'mail.form.required'
  else if (!isAddress(`${local}@${domain ?? 'example.com'}`)) out.localPart = 'mail.form.localPart'
  return out
}

/** The address the identity will send from ("noreply@mail.example.com"), or null while the domain is not valid. */
export function fromAddressOf(draft: AddDomainDraft): string | null {
  const domain = domainOf(draft.domain)
  const local = draft.localPart.trim().toLowerCase()
  return domain && local ? `${local}@${domain}` : null
}

export interface MailAbilities {
  /** email.manage (step-up): add a domain, check it. */
  manage: boolean
}

export interface MailDomainModel {
  identities: Loaded<SendingIdentity>
  companies: ReadonlyArray<{ id: string; name: string }>
  /** The SES accounts a new identity can send through (from the connections list). */
  sesAccounts: ReadonlyArray<Pick<IntegrationAccount, 'id' | 'label' | 'mode' | 'status'>>
  can: MailAbilities
  /** The add dialog, with a draft (fixtures) or a fresh one. */
  add?: { draft?: AddDomainDraft } | null
  /** The identity a check runs for. */
  checking?: string | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
}

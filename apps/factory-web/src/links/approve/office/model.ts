import type { ApiError } from '../../../lib/api/errors'
import { RECORD_PAGES, recordAddress } from '../../../lib/records/record-links'
import { companyPrefix } from '../../../lib/session/session'
import type { MailOpen } from './api'

/**
 * PLT-089 — the quick office sign-in that opens an approval from its e-mail (design links.approve addr: "Staff approvals
 * from e-mail open the Office approval in this frame after a quick sign-in, so margin stays behind the Office's grains").
 * What the page shows, pure, so the tests hold it.
 */

/** The cookie that keeps the company's sign-in name on this device (the office sign-in's own, SCR-001; not secret). */
export const TENANT_COOKIE = 'factory_tenant'

const KEY = /^am1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/

/** The mailed key from the address's fragment (`#key=am1…`), or null for anything that is not one. */
export function mailKeyFromFragment(hash: string | null | undefined): string | null {
  if (!hash) return null
  const key = new URLSearchParams(hash.replace(/^#/, '')).get('key')?.trim() ?? ''
  return KEY.test(key) ? key : null
}

export type OfficeStage =
  | { kind: 'checking' }
  /** The address holds no key (copied without its end, or opened from somewhere else). */
  | { kind: 'missing' }
  | { kind: 'sign-in' }
  | { kind: 'code' }
  | { kind: 'opening' }
  /** Waiting: the office page opens (by itself; the link is there if the browser stops it). */
  | { kind: 'open'; href: string; label: string }
  /** It no longer waits: someone decided it, or it moved on. */
  | { kind: 'decided'; href: string; label: string }
  /** Not this person's (a forwarded mail), or not a key at all: the one answer. */
  | { kind: 'not-valid'; home: string | null }
  /** The office asks for a new password first: the full sign-in page does that. */
  | { kind: 'change-password' }
  /** The person's role needs two-factor they have not set up. */
  | { kind: 'setup-2fa'; href: string }
  | { kind: 'error' }

export type SignInProblem = 'wrongCredentials' | 'wrongCode' | 'suspended' | 'rateLimited' | 'invalid' | 'unavailable'

export interface OfficeApprovalViewModel {
  stage: OfficeStage
  /** The sign-in name of the company, remembered on this device. */
  company: string
  email: string
  code: string
  busy: boolean
  problem: SignInProblem | null
}

/** Why a sign-in failed, without telling which part was wrong (`stage`: the password form or the code form). */
export function signInProblemOf(error: Pick<ApiError, 'kind'>, stage: 'password' | 'code'): SignInProblem {
  switch (error.kind) {
    case 'signed_out':
      return stage === 'code' ? 'wrongCode' : 'wrongCredentials'
    case 'forbidden':
      return 'suspended'
    case 'rate_limited':
      return 'rateLimited'
    case 'invalid':
      return 'invalid'
    default:
      return 'unavailable'
  }
}

/** Every record page this build has (the link column cannot read the office's built list; RECORD_PAGES lists only built ones). */
const BUILT: ReadonlySet<string> = new Set(Object.values(RECORD_PAGES))

/**
 * The office address of the mailed approval: its company's office (by id among the person's companies, else the
 * session's), then the notification's anchor — an approval in Home › Approvals' review, a task in My tasks, a Today row —
 * or the record itself. Null when the person reaches no company.
 */
export function officeAddress(opened: Pick<MailOpen, 'record' | 'companyId' | 'anchor'>, companies: ReadonlyArray<{ id: string; code: string }>, own: { code: string } | null): string | null {
  const company = companies.find((item) => item.id === opened.companyId) ?? own ?? companies[0] ?? null
  if (!company) return null
  const prefix = companyPrefix(company.code)
  const anchor = opened.anchor ?? ''
  const at = anchor.indexOf(':')
  const kind = at < 0 ? '' : anchor.slice(0, at)
  const id = at < 0 ? '' : anchor.slice(at + 1)
  if (kind === 'approval' && id) return `${prefix}/home/approvals?open=${encodeURIComponent(id)}`
  if (kind === 'task' && id) return `${prefix}/home/tasks?open=${encodeURIComponent(id)}`
  if (kind === 'today' && id) return `${prefix}/home/today?open=${encodeURIComponent(id)}`
  return `${prefix}${recordAddress({ type: opened.record.type, id: opened.record.id, label: opened.record.label, companyId: opened.companyId }, BUILT)}`
}

/** Home › Approvals of the person's company (where every approval that waits for them is). */
export const approvalsHome = (company: { code: string } | null): string | null => (company ? `${companyPrefix(company.code)}/home/approvals` : null)

/** The sign-in form's own check: a message key of `link-approve` per field, before anything is sent. */
export function signInFieldProblems(values: { company: string; email: string; password: string }): Partial<Record<'company' | 'email' | 'password', string>> {
  const problems: Partial<Record<'company' | 'email' | 'password', string>> = {}
  if (values.company.trim() === '') problems.company = 'office.field.company'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) problems.email = 'office.field.email'
  if (values.password === '') problems.password = 'office.field.password'
  return problems
}

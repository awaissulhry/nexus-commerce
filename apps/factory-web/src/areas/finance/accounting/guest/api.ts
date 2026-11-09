import {
  accountantsAnswer,
  changedAccountantAnswer,
  endedAccountantAnswer,
  invitedAccountantAnswer,
  type AccountantsAnswer,
  type ChangeAccountantBody,
  type EndAccountantBody,
  type InviteAccountantBody,
} from '@nexus/factory-domain/accounting/guest/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Accountant access on Finance › Close (B-W2b-201; the finance.accounting connection "Portal › Accountant"): the company's
 * adviser firms and their accountants, the newest downloads; give access, move its end, end it now (each behind the
 * office step-up). The shapes are factory-domain's contracts.
 */

export type Accountants = AccountantsAnswer
export type Firm = AccountantsAnswer['firms'][number]
export type Accountant = Firm['people'][number]
export type Download = AccountantsAnswer['downloads'][number]

export const fetchAccountants = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<Accountants> =>
  api.get('/accounting/accountants', { query: { companyId }, schema: accountantsAnswer, signal })

export const inviteAccountant = (api: ApiClient, body: InviteAccountantBody, idempotencyKey: string) => api.post('/accounting/accountants', { body, idempotencyKey, schema: invitedAccountantAnswer })

export const changeAccountant = (api: ApiClient, userId: string, body: ChangeAccountantBody, idempotencyKey: string) =>
  api.request('PATCH', `/accounting/accountants/${encodeURIComponent(userId)}`, { body, idempotencyKey, schema: changedAccountantAnswer })

export const endAccountant = (api: ApiClient, userId: string, body: EndAccountantBody, idempotencyKey: string) =>
  api.post(`/accounting/accountants/${encodeURIComponent(userId)}/end`, { body, idempotencyKey, schema: endedAccountantAnswer })

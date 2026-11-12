import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { maskedIban, planProposal, PORTAL_WAITING_WORDS, type BankAccountStatus } from '@nexus/factory-domain/purchasing/bank/rules'
import { PORTAL_SUPPLIER_BANK_PROPOSE } from '@nexus/factory-domain/purchasing/bank/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { requirePortalStepUp } from '../../../platform/auth/portal/step-up'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { proposeInCommand, type ProposeBody } from '../bank/bank'
import { PARTNER_ACCOUNT_COLUMNS, type PartnerAccountRow } from '../bank/store'

/**
 * Bank details in the supplier's portal profile (B-W2b-315; SCM-007, follow-up VN2:03 "Bank details join the supplier's
 * portal profile: propose only, verified by a second person after a call-back"; design portal.supplier.profile › Bank
 * details "IBAN masked (IT** **** **** 1234) · bank · account holder · 'Last changed 3 Mar 2026'", "Change bank details →
 * step-up dialog → form → review → Send", pop-up New bank details):
 *
 *   GET  /portal/supplier-bank   the organisation's accounts with us, masked; the one payments use ("Last changed …"); a
 *                                change waiting, with "we call you on your registered number before any payment uses the
 *                                new account; payments go to the old account until then"
 *   POST /portal/supplier-bank   new bank details (a fresh e-mail step-up on this session): PROPOSED in the PARTNER scope (its
 *                                grants let it insert only a PROPOSED account of its own party, by one of its own people);
 *                                nothing changes for payments until the office called back on a number it had BEFORE and a
 *                                second person checked it (modules/purchasing/bank)
 *
 * Reading is portal.supplierBank.view (the supplier's Invoices role, each Admin), proposing portal.supplierBank.propose (the
 * Admin); never an office preview. The full IBAN is never sent back (B-W2b-287's Decided 1: the partner could read its
 * own; we answer the masked one). Nothing goes by mail.
 */

export const BANK_LIVE_EVENTS = ['supplier_bank_account.proposed', 'supplier_bank_account.called_back', 'supplier_bank_account.activated', 'supplier_bank_account.refused', 'supplier_bank_account.retired'] as const
const SHOWN = 20

const stateOf = (status: BankAccountStatus): 'USABLE' | 'WAITING' | 'REFUSED' | 'RETIRED' => (status === 'ACTIVE' ? 'USABLE' : status === 'PROPOSED' || status === 'VERIFIED' ? 'WAITING' : status)

const viewOf = (row: PartnerAccountRow) => ({
  id: row.id,
  masked: maskedIban(row.ibanCountry, row.ibanLast4),
  bankName: row.bankName,
  holder: row.holder,
  currency: row.currency,
  state: stateOf(row.status as BankAccountStatus),
  proposedAt: toUtcIso(row.proposedAt),
  activatedAt: row.activatedAt ? toUtcIso(row.activatedAt) : null,
  refusedAt: row.refusedAt ? toUtcIso(row.refusedAt) : null,
  reason: row.status === 'REFUSED' ? row.refuseReason : null,
  retiredAt: row.retiredAt ? toUtcIso(row.retiredAt) : null,
})

export function mayPropose(request: FastifyRequest, session: PortalSession): boolean {
  if (session.preview) return false
  return can(actorOf(requireContext(request)), PORTAL_SUPPLIER_BANK_PROPOSE, { companyId: session.company.id, partyId: session.partyId })
}

/** GET /portal/supplier-bank (portal.supplierBank.view). */
export async function portalBank(request: FastifyRequest) {
  const session = portalSessionOf(request)
  // The party's own accounts in its scope (row-level security: its own; the hidden columns are never selected).
  const rows = await request.withClient((client) => client.supplierBankAccount.findMany({ where: { partyId: session.partyId }, select: PARTNER_ACCOUNT_COLUMNS, orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }], take: SHOWN }))
  const accounts = rows.map(viewOf)
  return {
    accounts,
    waitingWords: accounts.some((account) => account.state === 'WAITING') ? PORTAL_WAITING_WORDS : null,
    mayPropose: mayPropose(request, session),
    live: { events: [...BANK_LIVE_EVENTS] },
  }
}

/** POST /portal/supplier-bank (portal.supplierBank.propose + a fresh step-up). */
export async function portalProposeBank(app: FastifyInstance, request: FastifyRequest, body: ProposeBody, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never proposes bank details for the supplier.')
  if (!mayPropose(request, session)) throw new ForbiddenError('Your access lets you see your bank details, not change them: ask your admin.')
  const plan = planProposal(body)
  if (!plan.ok) throw new ValidationError(plan.issues[0]!.message, plan.issues)
  requirePortalStepUp(app, request)
  // In the PARTNER scope: its grants insert only a PROPOSED account of its own party, by one of its own people.
  const { result } = await commandOn(app, request, { name: 'purchasing.bank.proposeByPartner', idempotencyKey, input: body }, async (tools) => ({
    accountId: await proposeInCommand(tools, { id: session.partyId, companyId: session.company.id }, body, { userId: session.userId, source: 'PORTAL' }),
  }))
  return { ...(await portalBank(request)), accountId: result.accountId }
}

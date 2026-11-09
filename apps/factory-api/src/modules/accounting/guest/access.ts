import type { FastifyInstance, FastifyRequest } from 'fastify'
import { GUEST_PROBLEM, GUEST_REFUSALS } from '@nexus/factory-domain/accounting/guest/files'
import { PORTAL_ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/guest/permissions'
import { handedOverMonths, parseGuestPeriod, shareOf, type GuestPeriod, type PeriodShare } from '@nexus/factory-domain/accounting/guest/periods'
import type { Month } from '@nexus/factory-domain/accounting/periods'
import { partnerKindsOf } from '@nexus/factory-domain/auth/partners/kinds'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import { appClock } from '../../../platform/portal/tasks/clock'
import { exportedBatches, firmName, firmOf, type BatchRow } from './store'

/**
 * Who reads the accountant's room (B-W2b-201; FIN-158, PLT-022): a portal session of an adviser party (the CONSULTANT
 * role: the GUEST portal) — the firm's own person (kind GUEST, role guest-accountant: the route's manifest checked
 * portal.accounting.view over the session's party), or an office preview of that party (read-only: the authenticator
 * refuses its downloads). The portal session ends by itself at the person's end of access (the authenticator).
 *
 * The GUEST GRANT names the company and the period before anything else is read: the company is the session's (the portal
 * the person signed in to; a firm of one company signs in only there, a firm of every company in any of them) and
 * portal.accounting.view must reach it and the party; the period is a month, quarter or year of which at least one month
 * was handed over (an EXPORTED batch of that company). Only then do the reads run in the tenant's SYSTEM scope (the
 * partner role reads none of these tables): files only, never a record.
 */

export interface GuestReader {
  readonly session: PortalSession
  readonly actor: Actor
  readonly tenantId: string
  readonly companyId: string
  readonly firm: { readonly id: string; readonly name: string }
  readonly preview: boolean
  /** The tenant's system scope (reads after the grant, the store's presigned links). */
  readonly system: CommandCaller
  readonly clock: Clock
}

/** A refusal with its code in the issue path (`problem/<CODE>`): the screen says it in its own words. */
const refuse = (code: keyof typeof GUEST_REFUSALS, status: 'forbidden' | 'conflict' | 'not_ready' = 'conflict'): DomainError =>
  new DomainError(status, GUEST_REFUSALS[code], [{ path: GUEST_PROBLEM(code), message: GUEST_REFUSALS[code] }])

/** The accountant's reader, or 403 NOT_ACCOUNTANT (another kind of partner, a party that is not an adviser). */
export async function guestReaderOf(app: FastifyInstance, request: FastifyRequest): Promise<GuestReader> {
  const context = requireContext(request)
  if (context.audience !== 'partner') throw refuse('NOT_ACCOUNTANT', 'forbidden')
  const session = portalSessionOf(request)
  const actor = actorOf(context)
  const system = systemCallerOf(request)(session.tenantId)
  const firm = await system.withClient((client) => firmOf(client, session.partyId))
  const kinds = firm ? partnerKindsOf(firm.roles) : []
  const person = session.person.partnerKind
  const guest = session.preview ? kinds.includes('GUEST') : person === 'GUEST' && kinds.includes('GUEST')
  // The grant names the company: the session's, which the firm must belong to (or be of every company) and the role reach.
  const company = session.company.id
  if (!firm || !guest || (firm.companyId !== null && firm.companyId !== company) || !can(actor, PORTAL_ACCOUNTING_VIEW, { companyId: company, partyId: session.partyId })) throw refuse('NOT_ACCOUNTANT', 'forbidden')
  return { session, actor, tenantId: session.tenantId, companyId: company, firm: { id: firm.id, name: firmName(firm) }, preview: session.preview, system, clock: appClock(app) }
}

export interface GuestGrant {
  readonly period: GuestPeriod
  readonly share: PeriodShare
  /** The company's EXPORTED batches (every month), read once. */
  readonly batches: readonly BatchRow[]
  readonly handedOver: readonly Month[]
}

/** The grant over a period: its handed-over months, or 409 PERIOD_NOT_SHARED (400 for a period that is none). */
export async function guestGrantOf(reader: GuestReader, periodKey: string): Promise<GuestGrant> {
  const period = parseGuestPeriod(periodKey)
  if (!period) throw new ValidationError('Expected a month (2026-10), a quarter (2026-Q4) or a year (2026).', [{ path: 'period', message: 'Expected a month, a quarter or a year.' }])
  const batches = await reader.system.withClient((client) => exportedBatches(client, reader.companyId))
  const handedOver = handedOverMonths(batches)
  const share = shareOf(period, handedOver)
  if (share.shared.length === 0) throw refuse('PERIOD_NOT_SHARED')
  return { period, share, batches, handedOver }
}

export const guestRefusal = refuse

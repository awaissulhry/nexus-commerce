import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { actingPermission } from '@nexus/factory-domain/insights/attention'
import { events as insightsEvents } from '@nexus/factory-domain/insights/events'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { events as salesEvents } from '@nexus/factory-domain/sales/events'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { Draft, FanOutRule, Reader, RuleContext } from '../fan-out'

/**
 * Approvals (design home.notifications "Approval waiting · Approval decided"; home.today waiting-on "Nudge"):
 *   quote.approval_requested   APPROVAL to each person who may decide it (Today's rule: quotes.approve over the quote,
 *                              never the asker, the margin grain for a margin-floor request), with the quote's value
 *                              (price grain) and margin % (margin grain) ONLY for a reader holding that grain
 *   quote.approval_decided     APPROVAL to the person who asked (not when they decided it themselves)
 *   attention.nudged           APPROVAL to the same deciders: the asker reminds them (Waiting on others › Nudge)
 */

const salesPayload = (type: string) => salesEvents.find((event) => event.type === type)!.payload
const nudgedPayload = insightsEvents.find((event) => event.type === 'attention.nudged')!.payload

interface Pending {
  readonly quote: { readonly id: string; readonly number: string; readonly companyId: string; readonly partyId: string }
  readonly version: { readonly currency: string; readonly netAmount: number; readonly marginPct: Prisma.Decimal | null }
  readonly approval: { readonly id: string; readonly reasons: readonly string[]; readonly createdById: string | null; readonly status: string; readonly decidedById: string | null }
}

async function approvalOf(context: RuleContext, approvalId: string): Promise<Pending | null> {
  const approval = await context.tx.quoteApproval.findUnique({
    where: { id: approvalId },
    select: { id: true, reasons: true, createdById: true, status: true, decidedById: true, quoteVersion: { select: { currency: true, netAmount: true, marginPct: true, quote: { select: { id: true, number: true, companyId: true, partyId: true } } } } },
  })
  if (!approval) return null
  const { quote, ...version } = approval.quoteVersion
  return { quote, version, approval }
}

/** The quote's value and margin, each only for a reader holding its grain (and marked with it: the API filters again). */
function figuresFor(reader: Reader, pending: Pending): Record<string, Prisma.InputJsonValue> {
  const grains = heldGrains(reader.actor)
  return {
    ...(grains.has('price') ? { netAmount: markMoney('price', { minor: pending.version.netAmount, currency: pending.version.currency }) as unknown as Prisma.InputJsonValue } : {}),
    ...(grains.has('margin') && pending.version.marginPct !== null ? { marginPct: markMoney('margin', pending.version.marginPct.toString()) as unknown as Prisma.InputJsonValue } : {}),
  }
}

/** The people who may decide the request now (Today's QUOTE_APPROVAL rule, for each of them), with their readers. */
async function decidersOf(context: RuleContext, pending: Pending): Promise<Reader[]> {
  const scope = { companyId: pending.quote.companyId, siteId: null, partyId: pending.quote.partyId }
  const question = {
    kind: 'QUOTE_APPROVAL' as const,
    scope,
    notBy: pending.approval.createdById ? [pending.approval.createdById] : [],
    ...(pending.approval.reasons.includes('MARGIN_FLOOR') ? { needsGrain: 'margin' as const } : {}),
  }
  const deciders: Reader[] = []
  for (const userId of await context.people()) {
    const reader = await context.reader(userId)
    if (reader && holds(reader.actor, HOME_VIEW) && actingPermission(reader, question) !== null) deciders.push(reader)
  }
  return deciders
}

/** The waiting request of a quote, if one waits (its latest PENDING approval). */
async function pendingOfQuote(context: RuleContext, quoteId: string): Promise<Pending | null> {
  const waiting = await context.tx.quoteApproval.findFirst({ where: { status: 'PENDING', quoteVersion: { quoteId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
  return waiting ? approvalOf(context, waiting.id) : null
}

/** Who may decide the quote's waiting request now (the nudge asks before it nudges: modules/insights waiting.ts). */
export async function quoteDeciders(context: RuleContext, quoteId: string): Promise<string[]> {
  const pending = await pendingOfQuote(context, quoteId)
  return pending ? (await decidersOf(context, pending)).map((reader) => reader.personId) : []
}

const record = (pending: Pending) => ({ type: 'Quote', id: pending.quote.id, label: pending.quote.number })

export const APPROVAL_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'sales.quoteApprovalRequested',
    events: ['quote.approval_requested'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = salesPayload('quote.approval_requested').parse(raw) as unknown as { approvalId: string; reasons: string[] }
      const pending = await approvalOf(context, payload.approvalId)
      if (!pending || pending.approval.status !== 'PENDING') return []
      return (await decidersOf(context, pending)).map((reader) => ({
        userId: reader.personId,
        category: 'APPROVAL' as const,
        record: record(pending),
        companyId: pending.quote.companyId,
        anchor: `approval:${pending.approval.id}`,
        messageKey: 'notifications.approval.quote_requested' as const,
        params: { actorId: pending.approval.createdById, reasons: payload.reasons, approvalId: pending.approval.id, ...figuresFor(reader, pending) },
        actorId: pending.approval.createdById,
      }))
    },
  },
  {
    name: 'sales.quoteApprovalDecided',
    events: ['quote.approval_decided'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = salesPayload('quote.approval_decided').parse(raw) as unknown as { approvalId: string; status: 'APPROVED' | 'REJECTED' }
      const pending = await approvalOf(context, payload.approvalId)
      const asker = pending?.approval.createdById ?? null
      if (!pending || asker === null) return []
      const reader = await context.reader(asker)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, QUOTES_VIEW, { companyId: pending.quote.companyId, partyId: pending.quote.partyId })) return []
      return [
        {
          userId: asker,
          category: 'APPROVAL',
          record: record(pending),
          companyId: pending.quote.companyId,
          anchor: `approval:${pending.approval.id}`,
          messageKey: 'notifications.approval.quote_decided',
          params: { actorId: pending.approval.decidedById, status: payload.status, approvalId: pending.approval.id },
          actorId: pending.approval.decidedById,
        },
      ]
    },
  },
  {
    name: 'insights.nudged',
    events: ['attention.nudged'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = nudgedPayload.parse(raw) as unknown as { kind: string; recordType: string; recordId: string; messageId: string; byId: string }
      if (payload.kind !== 'APPROVAL_REQUEST' || payload.recordType !== 'Quote') return []
      const pending = await pendingOfQuote(context, payload.recordId)
      if (!pending) return []
      return (await decidersOf(context, pending)).map((reader) => ({
        userId: reader.personId,
        category: 'APPROVAL' as const,
        record: record(pending),
        companyId: pending.quote.companyId,
        anchor: `message:${payload.messageId}`,
        messageKey: 'notifications.approval.nudged' as const,
        params: { actorId: payload.byId, approvalId: pending.approval.id },
        actorId: payload.byId,
      }))
    },
  },
])

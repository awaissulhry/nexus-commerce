import type { Prisma } from '@nexus/factory-db'
import { holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { smvChangeWords } from '@nexus/factory-domain/insights/words'
import { events as minuteEvents } from '@nexus/factory-domain/product-minutes/events'
import { PRODUCT_SMV_APPROVE } from '@nexus/factory-domain/product/minutes/permissions'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { mayWrite } from '../../product/materials/store'
import { capped, dayOf, SOURCE_LIMIT, type Source } from './common'

/**
 * SMV changes waiting for a second person (B-W2b-307, follow-up AW2:02; B-W2b-215's gap "a waiting SMV change is not in the
 * approvals inbox nor mailed to approvers"; design home.approvals "every request that needs my yes", products.changes "the
 * SMV changes waiting from Operations land here too"). A PROPOSED version of an operation the viewer sees (product.routing.
 * view), theirs when they approve SMV changes for the operation's company — an operation for every company only by a grant
 * over every company, as the minutes module decides (product.smv.approve, `mayWrite`) — and they did not propose it (four
 * eyes: notBy). The row opens Products › Changes & versions with the decide pop-up (`?decide=smv:<version id>`, factory-web
 * ATTENTION_PAGES): its record is the version. Oldest first.
 *
 * Its approvers are told (`SMV_CHANGE_NOTICES`, one line in platform/notifications/rules): `smv_version.changed` PROPOSED
 * makes an APPROVAL notification for each person who reaches Home and may decide it, never the proposer.
 */

const OPERATION_SCOPE = { company: { field: 'companyId', nullable: true } } as const

export const smvChange: Source = async ({ caller, viewer }) => {
  const operations = scopeWhere(viewer.actor, PRODUCT_ROUTING_VIEW, OPERATION_SCOPE) as Prisma.OperationWhereInput
  return caller.withClient(async (db) => {
    const found = await db.operationTimeVersion.findMany({
      where: { status: 'PROPOSED', operation: operations },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, standardMinutes: true, effectiveFrom: true, proposedById: true, createdAt: true, operation: { select: { id: true, code: true, companyId: true } } },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = rows
      // An operation for every company is decided only by a grant over every company (the module's rule, said here first).
      .filter((row) => mayWrite(viewer.actor, PRODUCT_SMV_APPROVE, row.operation.companyId))
      .map((row) => ({
        kind: 'SMV_CHANGE',
        state: 'PROPOSED',
        severity: 'MEDIUM',
        record: { type: 'OperationTimeVersion', id: row.id, label: `${row.operation.code} v${row.number}` },
        scope: { companyId: row.operation.companyId, siteId: null, partyId: null },
        ...smvChangeWords({ code: row.operation.code, minutes: decimalText(row.standardMinutes.toString()), effectiveDate: dayOf(row.effectiveFrom) }),
        // Its first day: an approval after it takes effect at once.
        due: dayOf(row.effectiveFrom),
        since: row.createdAt,
        notBy: [row.proposedById],
      }))
    return { kind: 'SMV_CHANGE', candidates, complete }
  })
}

const changedPayload = minuteEvents.find((event) => event.type === 'smv_version.changed')!.payload

/** The people who may decide a proposal: they reach Home, see the operation and approve SMV changes for its company. */
async function approversOf(context: RuleContext, companyId: string | null, proposer: string): Promise<string[]> {
  const people: string[] = []
  for (const userId of await context.people()) {
    if (userId === proposer) continue
    const reader = await context.reader(userId)
    if (reader && holds(reader.actor, HOME_VIEW) && mayWrite(reader.actor, PRODUCT_ROUTING_VIEW, companyId) && mayWrite(reader.actor, PRODUCT_SMV_APPROVE, companyId)) people.push(userId)
  }
  return people
}

export const SMV_CHANGE_NOTICES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'insights.smvChangeAsked',
    events: ['smv_version.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = changedPayload.parse(raw) as { operationId: string; code: string; versionId: string; number: number; change: string; standardMinutes: string; effectiveFrom: string }
      if (payload.change !== 'PROPOSED') return []
      const version = await context.tx.operationTimeVersion.findUnique({ where: { id: payload.versionId }, select: { status: true, proposedById: true, operation: { select: { companyId: true } } } })
      if (!version || version.status !== 'PROPOSED') return []
      const title = `v${payload.number}: ${payload.standardMinutes} min, ${payload.effectiveFrom}`
      return (await approversOf(context, version.operation.companyId, version.proposedById)).map((userId) => ({
        userId,
        category: 'APPROVAL' as const,
        record: { type: 'Operation', id: payload.operationId, label: payload.code },
        companyId: version.operation.companyId,
        anchor: `smv:${payload.versionId}`,
        messageKey: 'notifications.approval.smvAsked' as const,
        params: { actorId: version.proposedById, title, versionId: payload.versionId },
        actorId: version.proposedById,
      }))
    },
  },
])

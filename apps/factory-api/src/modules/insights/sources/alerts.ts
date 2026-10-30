import type { Prisma } from '@nexus/factory-db'
import { isForMe, isRecipient } from '@nexus/factory-domain/alerts/rules'
import { alertRowPhrase, alertWhyPhrase, TODAY_SEVERITY } from '@nexus/factory-domain/alerts/today'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { ALERT_COLUMNS, heldOf, visibleWhere } from '../../../platform/alerts/store'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * The exception rules' stored alerts on Today (B-W2a-33; design home.alerts conn "Today's Needs me shows my open alerts";
 * W1 note "move to stored alerts at scale"): the alerts the person may see (alerts.view and the record's own view
 * permission over its place: platform/alerts/store) that are theirs now — unresolved, not snoozed, assigned to them, or
 * nobody's yet and their rule tells them (they hold its recipient role at the record's place). One row per alert (record
 * type `Alert`: the row opens the alert, which links its record), ranked by the alert's severity, due on the date a DATE
 * alert watches (an order's promise for a late order). Handled in the alert (acknowledge, assign, snooze, resolve with a
 * note), never with Today's own verbs (insights/actions takesActions). Read only when Today is asked for it (include=ALERTS).
 */
export const ruleAlerts: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const where: Prisma.AlertWhereInput = {
      AND: [visibleWhere(viewer.actor), { state: { not: 'RESOLVED' } }, { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: viewer.now } }] }],
    }
    const found = await db.alert.findMany({ where, orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }], take: SOURCE_LIMIT + 1, select: ALERT_COLUMNS })
    const held = await heldOf(db, viewer.personId, viewer.now)
    const mine = found.filter((row) => isForMe(row, viewer.personId, isRecipient(held, row.rule.recipientRoleId, row), viewer.now))
    const { rows, complete } = capped(mine, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {}) as Record<string, unknown>
      const due = typeof facts.dueDate === 'string' ? facts.dueDate : typeof facts.promiseDate === 'string' ? facts.promiseDate : null
      const assignedToMe = row.assignedToId === viewer.personId
      return {
        kind: 'RULE_ALERT',
        state: row.state,
        severity: TODAY_SEVERITY[row.severity],
        record: { type: 'Alert', id: row.id, label: row.recordLabel },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
        sentence: alertRowPhrase(row.ruleKind, row.recordLabel, row.facts),
        blocks: null,
        due,
        since: row.raisedAt,
        why: () => alertWhyPhrase(assignedToMe, row.rule.name),
        condition: [row.ruleKind, row.state, row.assignedToId ?? '-'],
      }
    })
    return { kind: 'RULE_ALERT', candidates, complete: complete && found.length <= SOURCE_LIMIT }
  })

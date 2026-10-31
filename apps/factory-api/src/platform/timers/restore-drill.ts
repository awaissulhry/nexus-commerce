import { holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { DRILL_TIMER_KIND } from '@nexus/factory-domain/ops/drills'
import { SECURITY_VIEW } from '@nexus/factory-domain/ops/permissions'
import { events as timerEvents } from '@nexus/factory-domain/timers/events'
import { parseTimerKey } from '@nexus/factory-domain/timers/rules'
import type { Draft, FanOutRule, RuleContext } from '../notifications/fan-out'

/**
 * The restore drill's reminder (B-W2b-24; B-W2a-36 note; PLT-214; design admin.security "Backups & restore"): the
 * Security command sets ONE `RESTORE_DRILL_DUE:-14d` timer on the tenant when a drill passes (admin/security/drills.ts,
 * through setTimerInCommand); when the scheduler fires it (`timer.fired`, no rule), this fan-out rule tells every ACTIVE
 * office person who holds security.view and reaches Home (home.view: the bell) — SYSTEM, anchored to the timer so a replay
 * tells nobody twice — naming the last drill that passed as the record (its page: Admin › Security & health). A drill
 * recorded meanwhile moved the timer (CANCELLED: MOVED), so a fired timer is still the one in force. Who is told is a
 * role's matter, never a chosen person.
 */

const payloadSchema = timerEvents.find((event) => event.type === 'timer.fired')!.payload

export const RESTORE_DRILL_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'security.drillDue',
    events: ['timer.fired'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadSchema.parse(raw) as { timerId: string; timerKey: string; ruleId: string | null; recordType: string; recordId: string }
      if (payload.ruleId !== null || payload.recordType !== 'Tenant' || parseTimerKey(payload.timerKey)?.kind !== DRILL_TIMER_KIND) return []
      const timer = await context.tx.dueTimer.findUnique({ where: { id: payload.timerId }, select: { status: true, dueAt: true, payload: true } })
      if (!timer || timer.status !== 'FIRED') return []
      const last = await context.tx.restoreDrill.findFirst({ where: { result: 'PASSED' }, orderBy: [{ drilledOn: 'desc' }, { id: 'desc' }], select: { id: true, drilledOn: true } })
      if (!last) return []
      const dueOn = typeof (timer.payload as { dueOn?: unknown } | null)?.dueOn === 'string' ? ((timer.payload as { dueOn: string }).dueOn) : timer.dueAt.toISOString().slice(0, 10)
      const drilledOn = last.drilledOn.toISOString().slice(0, 10)
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !holds(reader.actor, SECURITY_VIEW)) continue
        drafts.push({
          userId,
          category: 'SYSTEM',
          record: { type: 'RestoreDrill', id: last.id, label: drilledOn },
          companyId: null,
          anchor: `drill-due:${payload.timerId}`,
          messageKey: 'notifications.security.drillDue',
          params: { title: dueOn, dueOn, drilledOn },
          actorId: null,
        })
      }
      return drafts
    },
  },
])

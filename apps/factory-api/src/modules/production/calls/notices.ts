import { events as andonEvents } from '@nexus/factory-domain/andon/events'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { PRODUCTION_CALLS_ANSWER } from '@nexus/factory-domain/production/calls/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { respondersOf } from './store'

/**
 * Who is told of a help call (B-W2b-35; MES-144 "call type → responder group; their phones get a push"): when a station
 * sends a call (`help_call.raised`), each office person behind the type's responder group — the current members of its
 * team, or (no team named) the site's team leaders: the leads of the teams of the call's line, else of the site — gets an
 * ALERT in the bell, anchored to the call (a replay tells nobody twice), if they still reach Home (home.view) and may
 * answer calls at the site now. The floor's people see it on their tablets at once (the live event); a push to a phone
 * is B-W2b-52's (personal phones). Quiet: nobody else, and the caller (a floor worker) never.
 */

const payloadSchema = andonEvents.find((event) => event.type === 'help_call.raised')!.payload

const TITLE_MAX = 80

export const CALL_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'calls.raised',
    events: ['help_call.raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadSchema.parse(raw) as { callId: string; typeId: string; code: string; stationId: string; lineId: string | null; responderTeamId: string | null }
      const call = await context.tx.helpCall.findUnique({
        where: { id: payload.callId },
        select: { siteId: true, status: true, station: { select: { companyId: true, code: true } }, line: { select: { code: true } }, type: { select: { code: true } } },
      })
      // Answered or closed before the fan-out ran: nobody needs telling.
      if (!call || call.status === 'SOLVED' || call.status === 'CANCELLED') return []
      const scope = { companyId: call.station.companyId, siteId: call.siteId }
      const words = await context.tx.reasonCode.findFirst({ where: { list: 'HELP_CALL', code: call.type.code }, select: { labelEn: true } })
      const title = `${words?.labelEn ?? call.type.code}${call.line ? ` · ${call.line.code}` : ''}`.slice(0, TITLE_MAX)
      const { userIds } = await respondersOf(context.tx, { siteId: call.siteId, responderTeamId: payload.responderTeamId, lineId: payload.lineId }, { accounts: true })
      const drafts: Draft[] = []
      for (const userId of userIds) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PRODUCTION_CALLS_ANSWER, scope)) continue
        drafts.push({
          userId,
          category: 'ALERT',
          record: { type: 'HelpCall', id: payload.callId, label: call.station.code },
          companyId: scope.companyId,
          anchor: `call:${payload.callId}`,
          messageKey: 'notifications.calls.raised',
          params: { title, callId: payload.callId, code: payload.code },
          actorId: null,
        })
      }
      return drafts
    },
  },
])

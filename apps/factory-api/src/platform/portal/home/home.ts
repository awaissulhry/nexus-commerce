import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isPartnerKind, PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { portalSessionOf } from '../../auth/portal/authenticator'
import { myTasks } from '../tasks/portal'
import { HOME_SOURCES } from './sources'

/**
 * The partner's Home and the rail's badges (B-W2b-167; design portal.frame rail "Badges count only what waits for THIS
 * person, with its noun", portal.customer.home / portal.supplier.home "Waiting for you" / "To do" and "At a glance"):
 *
 *   GET /portal/home    what waits for the person (the first 8 of the one task list, due first), the rail's badges per area,
 *                       and every count the sources declare for the person's kind (null: it could not be counted)
 * One request for the frame's first paint; the live channel (`GET /portal/live`) says when to read it again.
 */

const WAITING_SHOWN = 8

export async function home(app: FastifyInstance, request: FastifyRequest, now: Date) {
  const session = portalSessionOf(request)
  const kind = isPartnerKind(session.person.partnerKind) ? session.person.partnerKind : null
  const tasks = await myTasks(request, 'OPEN', now)
  const counts: { key: string; area: string; words: { it: string; en: string }; value: number | null }[] = []
  for (const source of HOME_SOURCES) {
    const shown = source.counts.filter((count) => (kind === null ? PARTNER_KINDS : [kind]).some((entry) => count.kinds.includes(entry)))
    if (shown.length === 0) continue
    let values: Readonly<Record<string, number | null>> = {}
    try {
      values = await source.read(app, request, now)
    } catch (error) {
      request.log.warn({ err: error, source: source.name }, 'a portal home count could not be read')
    }
    for (const count of shown) counts.push({ key: count.key, area: count.area, words: { it: count.words.it, en: count.words.en }, value: values[count.key] ?? null })
  }
  return {
    asOf: toUtcIso(now),
    kind,
    waiting: tasks.items.slice(0, WAITING_SHOWN),
    badges: tasks.badges,
    counts,
    live: { events: [...tasks.live.events, 'partner_notification.created'] },
  }
}

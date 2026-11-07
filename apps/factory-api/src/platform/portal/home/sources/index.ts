import type { FastifyInstance, FastifyRequest } from 'fastify'
import { homeCountProblems, type HomeCountDefinition } from '@nexus/factory-domain/portal/home/counts'
import { NOTIFICATION_COUNTS } from './notifications'
import { PURCHASE_ORDER_COUNTS } from './purchase-orders'
import { TASK_COUNTS } from './tasks'

/**
 * Where a partner's Home counts come from (B-W2b-167; plan W2b-3 "Sources": "Home counts through a sources folder like the
 * tasks"): one file per source in this folder, one line in the list below (a merge point). A source declares its counts
 * (factory-domain portal/home/counts.ts: key, area, partner kinds, words) and reads them for one request, in the session's
 * party scope (row-level security), as the person sees them. A count it cannot read is null ("shows nothing, never 0").
 * Later steps add theirs: open orders, in production, shipping this week (B-W2b-175), to confirm, late (B-W2b-174), …
 */
export interface HomeSource {
  readonly name: string
  readonly counts: readonly HomeCountDefinition[]
  read(app: FastifyInstance, request: FastifyRequest, now: Date): Promise<Readonly<Record<string, number | null>>>
}

export const HOME_SOURCES: readonly HomeSource[] = Object.freeze([
  // B-W2b-167: what waits for the person (the one task list) and their unread notifications.
  TASK_COUNTS,
  NOTIFICATION_COUNTS,
  // B-W2b-174: the supplier's purchase orders to confirm and late.
  PURCHASE_ORDER_COUNTS,
])

const problems = homeCountProblems(HOME_SOURCES.flatMap((source) => source.counts))
if (problems.length > 0) throw new Error(`Portal home counts are not valid: ${problems.join('; ')}`)

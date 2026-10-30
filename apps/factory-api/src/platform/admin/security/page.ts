import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@nexus/factory-domain/auth/password/password'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DrillStatus } from '@nexus/factory-domain/ops/drills'
import { SIGN_IN_RULES } from '@nexus/factory-domain/ops/two-factor'
import { actorOf, requireContext } from '../../../core/context'
import { liveAssignment } from '../../auth/roles/access'
import { STEP_UP_VALID_MS, SESSION_LIFETIME } from '../../auth/sessions/session-store'
import type { OfficeAuth } from '../../auth/sessions/office-auth'
import type { StatusLine } from './contract'
import { drillsOf } from './drills'

/**
 * `GET /admin/security` (B-W2a-36; SCR-166; design admin.security): the page in one read, every line a fact the API can
 * see for itself, never assumed:
 *
 *   status      api and database (this answer reached both), background jobs (the tenant's outbox: waiting, the oldest
 *               one's age, failed for good), scheduled jobs and backups (not watched by Nexus yet: said so, never "ok"),
 *               files (the tenant's file store and its mode; quarantined files of the last 30 days), the restore drill
 *   signIn      the fixed rules (passwords, lockout, sessions, the step-up's life) and, for a reader with roles.view, how
 *               many office roles ask for two-factor and how many of their holders have none yet
 *   backups     the drill's state and the last drills (the page's "Record a restore drill" with security.drills.record)
 *   protection  facts of the code and the providers: in transit (HSTS on every answer), at rest (the providers'),
 *               secrets sealed per field (how many), bank details (step-up and walls, not sealed per field), web
 *               security headers, virus scan on uploads (not yet: B-W2a-42 with the Owner's yes)
 */

const JOBS_LATE_MS = 5 * 60_000
const DAY_MS = 86_400_000

const line = (part: StatusLine['part'], state: StatusLine['state'], facts: Partial<Omit<StatusLine, 'part' | 'state'>> = {}): StatusLine => ({
  part,
  state,
  count: facts.count ?? null,
  minutes: facts.minutes ?? null,
  at: facts.at ?? null,
  days: facts.days ?? null,
  mode: facts.mode ?? null,
})

export function drillLine(status: DrillStatus): StatusLine {
  const state: StatusLine['state'] = status.state === 'ok' ? 'ok' : status.state === 'due_soon' ? 'warning' : status.state === 'none' ? 'needs' : 'failing'
  return line('drill', state, { at: status.lastOn, days: status.daysLeft })
}

/** The tenant's outbox: events waiting, the oldest one's age, and the ones that failed for good. */
export async function jobsLine(client: FactoryClient, now: Date): Promise<StatusLine> {
  const pending = await client.outboxEvent.count({ where: { status: 'PENDING' } })
  const dead = await client.outboxEvent.count({ where: { status: 'DEAD' } })
  const oldest = (await client.outboxEvent.aggregate({ where: { status: 'PENDING' }, _min: { occurredAt: true } }))._min.occurredAt
  const waitedMs = oldest ? Math.max(0, now.getTime() - oldest.getTime()) : 0
  const state: StatusLine['state'] = dead > 0 ? 'failing' : waitedMs > JOBS_LATE_MS ? 'warning' : 'ok'
  return line('jobs', state, { count: dead > 0 ? dead : pending, minutes: oldest ? Math.floor(waitedMs / 60_000) : null })
}

/** Files quarantined (held back) in the last 30 days. */
const quarantinedSince = (client: FactoryClient, now: Date) => client.storedFile.count({ where: { status: 'QUARANTINED', updatedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } } })

function filesLine(stores: readonly { mode: string; status: string }[], quarantined: number): StatusLine {
  if (stores.length === 0) return line('files', 'needs')
  const paused = stores.every((store) => store.status === 'PAUSED')
  const mode = stores.some((store) => store.mode === 'LIVE') ? 'LIVE' : stores[0]!.mode
  return line('files', paused ? 'failing' : quarantined > 0 ? 'warning' : 'ok', { mode, count: quarantined })
}

export async function securityPage(auth: OfficeAuth, request: FastifyRequest) {
  const context = requireContext(request)
  const actor = actorOf(context)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const { drills, status: drill } = await drillsOf(client, now, 10)
    const jobs = await jobsLine(client, now)
    const stores = await client.integrationAccount.findMany({ where: { provider: 'R2', status: { not: 'DISABLED' } }, select: { mode: true, status: true } })
    const quarantined = await quarantinedSince(client, now)
    const files = filesLine(stores, quarantined)
    const sealed = await client.secretValue.count()

    let twoFactor: { officeRoles: number; asking: number; holdersWithout: number } | null = null
    if (holds(actor, 'roles.view')) {
      const roles = await client.role.findMany({ where: { audience: 'OFFICE' }, select: { id: true, requireMfa: true } })
      const asking = roles.filter((role) => role.requireMfa).map((role) => role.id)
      const without = await client.roleAssignment.findMany({
        where: { roleId: { in: asking }, ...liveAssignment(now), user: { status: { in: ['ACTIVE', 'INVITED'] }, totpConfirmedAt: null } },
        select: { userId: true },
        distinct: ['userId'],
      })
      twoFactor = { officeRoles: roles.length, asking: asking.length, holdersWithout: without.length }
    }

    return {
      asOf: toUtcIso(now),
      status: [
        line('api', 'ok', { at: toUtcIso(now) }),
        line('database', 'ok', { at: toUtcIso(now) }),
        jobs,
        // The scheduler's crons claim each tick in Redis and leave no record a page can read (W2b: Jobs and integrations).
        line('scheduled', 'unknown'),
        files,
        // The database provider's point-in-time recovery and the second EU copy (B-W0-32, GATE-SPEND) are not readable here.
        line('backups', 'unknown'),
        drillLine(drill),
      ],
      signIn: {
        password: { minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
        lockout: SIGN_IN_RULES.lockout,
        sessions: { idleHours: SESSION_LIFETIME.idleMs / 3_600_000, absoluteDays: SESSION_LIFETIME.absoluteMs / DAY_MS, stepUpMinutes: STEP_UP_VALID_MS / 60_000 },
        twoFactor,
      },
      backups: { drill, drills, canRecord: holds(actor, 'security.drills.record') },
      protection: [
        { fact: 'inTransit' as const, state: 'on' as const, count: null },
        { fact: 'atRest' as const, state: 'provider' as const, count: null },
        { fact: 'secrets' as const, state: 'on' as const, count: sealed },
        { fact: 'bank' as const, state: 'partly' as const, count: null },
        { fact: 'headers' as const, state: 'on' as const, count: null },
        { fact: 'virusScan' as const, state: 'off' as const, count: quarantined },
      ],
    }
  })
}

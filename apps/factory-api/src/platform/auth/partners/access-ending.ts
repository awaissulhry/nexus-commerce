import type { FactoryDatabase } from '@nexus/factory-db'
import { PARTNER_PEOPLE } from '@nexus/factory-domain/auth/partners/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../outbox/system'
import { companyById, contactOf } from '../portal/store'
import { partnerMailerOf, type PartnerMailer } from './mail'

/**
 * "Access ends soon" (B-W2b-162; PLT-022 time-boxed access; design admin.users "access ends soon", portal.guest.accountant
 * "Ends 31 Jan 2027"): the scheduler's clustered cron `partners.accessEnding`, daily at 07:20 Europe/Rome, per ACTIVE tenant
 * in its system context. A partner person (ACTIVE or SUSPENDED) whose end of access falls within the next 7 days is told
 * ONCE per end of access: one command per person keyed `partners-access-ending:<person>:<end>` (a later tick, or a second
 * replica, answers from its receipt and mails nothing), with its audit row and the event partner_user.access_ending (the
 * office's lists and, with B-W2b-167, the partner's notifications); then one mail to the person (FAKE locally). The access
 * itself ends by itself: the portal authenticator refuses a session past User.accessUntil on its next request
 * (auth/portal/access.ts ENDED), and a sign-in after it is told so in words.
 */

export interface AccessEndingOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly mailer?: PartnerMailer
}

const BATCH = 500

/** One tick over every active tenant (the cron's; tests call it directly). How many people were told. */
export async function noticeAccessEnding(options: AccessEndingOptions): Promise<number> {
  const clock = options.clock ?? serverClock
  const settings = { ...COMMAND_SETTINGS, clock }
  const mailer = options.mailer ?? partnerMailerOf(options.database, clock)
  const now = clock.now()
  const until = new Date(now.getTime() + PARTNER_PEOPLE.accessEndingNoticeMs)
  const requestId = `partners-access-ending-${newId()}`
  let told = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await caller.withClient((client) =>
        client.user.findMany({
          where: { audience: 'PARTNER', status: { in: ['ACTIVE', 'SUSPENDED'] }, accessUntil: { gt: now, lte: until } },
          orderBy: [{ accessUntil: 'asc' }, { id: 'asc' }],
          take: BATCH,
          select: { id: true, email: true, partyId: true, accessUntil: true, party: { select: { companyId: true } } },
        }),
      )
      for (const person of due) {
        const accessUntil = person.accessUntil!
        const partyId = person.partyId!
        try {
          const outcome = await runCommand(
            caller,
            { name: 'partners.accessEnding', idempotencyKey: `partners-access-ending:${person.id}:${accessUntil.getTime()}`, input: { userId: person.id, accessUntil: toUtcIso(accessUntil) } },
            async ({ tx, audit, emit }) => {
              // The company whose portal it is: the party's own, else the one of the person's last portal session, else the tenant's first.
              const session = await tx.session.findFirst({ where: { userId: person.id, audience: 'PARTNER', previewOfPartyId: null, companyId: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { companyId: true } })
              const first = await tx.company.findFirst({ where: { status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
              const companyId = person.party?.companyId ?? session?.companyId ?? first?.id ?? null
              audit({ recordType: 'User', recordId: person.id, companyId, after: { accessEndingNotice: toUtcIso(accessUntil) } })
              emit({ type: 'partner_user.access_ending', subject: person.id, companyId, payload: { userId: person.id, partyId, accessUntil: toUtcIso(accessUntil) } })
              return { companyId }
            },
            settings,
          )
          if (outcome.replayed) continue
          told++
          const companyId = outcome.result.companyId
          if (companyId === null) continue
          const contact = await caller.withClient(async (client) => {
            const company = await companyById(client, companyId)
            return company ? contactOf(client, company) : ''
          })
          await mailer.deliver({ kind: 'access_ending', tenantId, companyId, userId: person.id, to: person.email, accessUntil, contact }).catch((error: unknown) => {
            options.log.error({ err: error, tenantId }, 'an "access ends soon" mail could not be sent')
          })
        } catch (error) {
          options.log.error({ err: error, tenantId }, 'a partner person could not be told that their access ends soon')
        }
      }
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the partner access endings of a tenant could not be read')
    }
  }
  if (told > 0) options.log.info({ told }, 'partner people told that their access ends soon')
  return told
}

/** The scheduler's cron: daily at 07:20 (Europe/Rome). */
export function accessEndingCron(options: AccessEndingOptions): CronJob {
  return defineCron({
    name: 'partners.accessEnding',
    schedule: '20 7 * * *',
    lockTtlMs: 600_000,
    async run() {
      await noticeAccessEnding(options)
    },
  })
}

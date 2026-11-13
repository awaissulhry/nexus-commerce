import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { newId } from '@nexus/factory-domain/core/ids'
import { choiceFor, kindOf, type EventKind } from '@nexus/factory-domain/notifications/preferences/preferences'
import { notificationPage, pushMessageOf } from '@nexus/factory-domain/notifications/preferences/push'
import { paramsFor, peopleOf, sentenceOf, type DigestLocale } from '@nexus/factory-domain/notifications/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../auth/roles/access'
import { processEmail } from '../../email-out/service'
import { companyCodeOf, pushToPerson } from '../push/subscriptions'
import { processPush } from '../push/service'
import type { PushUrgency } from '../push/web-push'
import { logDeliveries, NOTIFICATION_COLUMNS } from '../store'
import { sendInstantMail } from './mail'
import { matrixOf } from './store'

/**
 * What a fan-out's notifications bring outside the app AS IT HAPPENS (B-W2b-385; PLT-140, PLT-141, PLT-152): after the
 * fan-out's command, for each notification of the event whose person's matrix says "as it happens" for its kind, one e-mail
 * (mail.ts) and one push to each of their live devices (push/subscriptions.ts). Each is written for its reader at this moment:
 * their language, the names of the people it names, its params cut to the grains they hold now (a price only for a person who
 * may see prices; a floor worker has no push and no office mail at all).
 *
 * The delivery log is the memory: a notification that has an EMAIL (or PUSH) delivery row is not sent that way again, so the
 * worker's retry of the same event (the fan-out answers from its receipt) delivers only what is still missing. A push that
 * reached no device because the person has none writes no row (no SKIPPED flood, as W2a); one that every device refused is
 * FAILED with why. The daily digest (platform/email-out/digest) takes the DAILY_DIGEST ones later.
 */

const URGENT: ReadonlySet<EventKind> = new Set(['APPROVAL_WAITING', 'AREA_ALERT'])
const urgencyOf = (kind: EventKind): PushUrgency => (URGENT.has(kind) ? 'high' : 'normal')

/** The instant mails and pushes of one event's notifications; how many went out each way. */
export async function deliverInstant(caller: CommandCaller, eventId: string): Promise<{ readonly mailed: number; readonly pushed: number }> {
  const context = caller.factoryContext
  const tenantId = context && 'tenantId' in context ? context.tenantId : null
  if (!tenantId) return { mailed: 0, pushed: 0 }
  const now = serverClock.now()
  const rows = await caller.withClient(async (client) => {
    const made = await client.notification.findMany({ where: { eventId, partyId: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500, select: NOTIFICATION_COLUMNS })
    const delivered = made.length ? await client.notificationDelivery.findMany({ where: { notificationId: { in: made.map((row) => row.id) }, channel: { in: ['EMAIL', 'PUSH'] } }, select: { notificationId: true, channel: true } }) : []
    const done = new Set(delivered.map((row) => `${row.notificationId}:${row.channel}`))
    const wanted: { row: (typeof made)[number]; kind: EventKind; email: boolean; push: boolean }[] = []
    const matrices = new Map<string, Awaited<ReturnType<typeof matrixOf>>>()
    // A push only for a person with a live device (most have none): the push runtime is asked only then.
    const devices = new Map<string, boolean>()
    for (const row of made) {
      const kind = kindOf(row)
      if (kind === null) continue
      if (!matrices.has(row.userId)) matrices.set(row.userId, await matrixOf(client, row.userId, now))
      const choice = choiceFor(matrices.get(row.userId)!.cells, kind)
      const email = choice.emailNow && !done.has(`${row.id}:EMAIL`)
      if (choice.pushNow && !devices.has(row.userId)) devices.set(row.userId, (await client.pushSubscription.count({ where: { userId: row.userId, revokedAt: null } })) > 0)
      const push = choice.pushNow && devices.get(row.userId) === true && !done.has(`${row.id}:PUSH`)
      if (email || push) wanted.push({ row, kind, email, push })
    }
    return wanted
  })
  if (rows.length === 0) return { mailed: 0, pushed: 0 }

  // Each person as they are now: language, address, grains; the names their sentences name; their company's code for links.
  const people = new Map<string, { email: string; displayName: string; locale: DigestLocale; grains: ReturnType<typeof heldGrains> } | null>()
  const names = new Map<string, string>()
  const codes = new Map<string, string>()
  await caller.withClient(async (client) => {
    for (const { row } of rows) {
      if (!people.has(row.userId)) {
        const user = await client.user.findFirst({ where: { id: row.userId, status: 'ACTIVE' }, select: { email: true, displayName: true, locale: true } })
        people.set(row.userId, user ? { email: user.email, displayName: user.displayName, locale: user.locale === 'en' ? 'en' : 'it', grains: heldGrains({ audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, row.userId, now), true) }) } : null)
      }
      const key = row.companyId ?? ''
      if (!codes.has(key)) codes.set(key, await companyCodeOf(client, row.companyId))
    }
    const ids = [...new Set(rows.flatMap(({ row }) => peopleOf(row)))].filter((id) => !names.has(id))
    if (ids.length) for (const user of await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })) names.set(user.id, user.displayName)
  })

  // Each runtime only when something goes that way (a test or a run without push keys never asks for push).
  const email = rows.some((entry) => entry.email) ? processEmail() : null
  const push = rows.some((entry) => entry.push) ? processPush() : null
  let mailed = 0
  let pushed = 0
  for (const { row, kind, email: byMail, push: byPush } of rows) {
    const person = people.get(row.userId)
    if (!person) continue
    const page = notificationPage(codes.get(row.companyId ?? '') ?? 'all', row.id)
    if (byMail && email) {
      const sentence = sentenceOf({ ...row, params: paramsFor(row.params, person.grains) }, names, person.locale)
      let outcome: { outcome: 'SENT' | 'FAILED'; outboundId: string | null; detail: string | null }
      try {
        outcome = await sendInstantMail(caller, email, { person: { id: row.userId, email: person.email, displayName: person.displayName, locale: person.locale }, companyId: row.companyId, subject: `${row.recordLabel}: ${sentence}`.slice(0, 200), sentence, link: `${email.webOrigin}${page}` })
      } catch {
        outcome = { outcome: 'FAILED', outboundId: null, detail: 'the mail could not be made' }
      }
      if (outcome.outcome === 'SENT') mailed += 1
      await logDelivery(caller, row.id, 'EMAIL', outcome.outcome, outcome.outboundId, outcome.detail)
    }
    if (byPush && push && push.unavailable === null) {
      const results = await pushToPerson(caller, { tenantId, userId: row.userId, message: pushMessageOf(row, person, names, page), urgency: urgencyOf(kind) }, push)
      if (results.length === 0) continue
      const took = results.filter((entry) => entry.outcome === 'SENT').length
      if (took > 0) pushed += 1
      await logDelivery(caller, row.id, 'PUSH', took > 0 ? 'SENT' : 'FAILED', null, took > 0 ? null : `no device took it (${results.map((entry) => entry.status || 'unreachable').join(', ')})`)
    }
  }
  return { mailed, pushed }
}

/** One delivery row, in its own command keyed by the notification and the channel (a retry writes none twice). */
async function logDelivery(caller: CommandCaller, notificationId: string, channel: 'EMAIL' | 'PUSH', outcome: 'SENT' | 'FAILED', outboundId: string | null, detail: string | null): Promise<void> {
  await command(caller, { name: 'notifications.delivered', idempotencyKey: `notify-deliver-${notificationId}-${channel}`, input: { notificationId, channel } }, async (tools) => {
    await logDeliveries(tools.tx, [{ id: newId(), notificationId, outcome, emailOutboundId: outcome === 'SENT' ? outboundId : null, detail: outcome === 'SENT' ? null : detail }], tools.now, tools.context.requestId, channel)
    tools.audit({ recordType: 'Notification', recordId: notificationId, after: { channel, outcome, ...(outboundId ? { emailOutboundId: outboundId } : {}) } })
    return null
  })
}

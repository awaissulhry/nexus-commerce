import type { FastifyRequest } from 'fastify'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, requireContext } from '../../../core/context'
import { liveAssignment } from '../../auth/roles/access'
import type { OfficeAuth } from '../../auth/sessions/office-auth'
import { ATTENTION_KINDS } from './contract'
import { drillsOf } from './drills'

/**
 * All settings › Needs attention (B-W2a-36; design admin.overview "Needs attention": set-up facts that went wrong since,
 * in one place, each → the page that fixes it). Any office session; each kind is read only where the person holds its
 * own view permission, over the companies and sites their grants reach (a kind they may not read is named in `unread`):
 *
 *   integrationFailing  integrations.view  an active connection whose last call failed after its last success
 *   mailDomain          email.send         a sending domain whose verification or DKIM records are not confirmed
 *   tabletUnseen        devices.view       an enrolled tablet not seen for 3 days or more
 *   drill               security.view      no restore drill yet, the last one failed, or one is due within 14 days
 *   jobsFailed          security.view      background events that failed for good (the outbox's DEAD)
 *   twoFactorMissing    roles.view         people whose role asks for two-factor and who have not set it up
 */

type Kind = (typeof ATTENTION_KINDS)[number]
type Item = { kind: Kind; subject: string | null; state: string | null; since: string | null; count: number | null; days: number | null; href: string; severity: 'warning' | 'critical' }

const RIGHT: Readonly<Record<Kind, string>> = {
  integrationFailing: 'integrations.view',
  mailDomain: 'email.send',
  tabletUnseen: 'devices.view',
  drill: 'security.view',
  jobsFailed: 'security.view',
  twoFactorMissing: 'roles.view',
}

export const TABLET_UNSEEN_DAYS = 3
const DAY_MS = 86_400_000

const item = (kind: Kind, href: string, facts: Partial<Omit<Item, 'kind' | 'href'>> = {}): Item => ({
  kind,
  href,
  subject: facts.subject ?? null,
  state: facts.state ?? null,
  since: facts.since ?? null,
  count: facts.count ?? null,
  days: facts.days ?? null,
  severity: facts.severity ?? 'warning',
})

export async function attentionList(auth: OfficeAuth, request: FastifyRequest) {
  const actor: Actor = actorOf(requireContext(request))
  const now = auth.clock.now()
  const may = (kind: Kind) => holds(actor, RIGHT[kind] as never)
  return request.withClient(async (client) => {
    const items: Item[] = []
    if (may('integrationFailing')) {
      const accounts = await client.integrationAccount.findMany({
        where: { AND: [scopeWhere(actor, 'integrations.view', { company: { field: 'companyId', nullable: true } }), { status: 'ACTIVE', lastErrorAt: { not: null } }] },
        select: { id: true, label: true, lastOkAt: true, lastErrorAt: true },
        orderBy: { lastErrorAt: 'desc' },
        take: 20,
      })
      for (const account of accounts) {
        if (account.lastOkAt && account.lastOkAt.getTime() >= account.lastErrorAt!.getTime()) continue
        items.push(item('integrationFailing', `/admin/connections/${account.id}`, { subject: account.label, since: toUtcIso(account.lastErrorAt!), severity: 'critical' }))
      }
    }
    if (may('mailDomain')) {
      const identities = await client.emailIdentity.findMany({
        where: { AND: [scopeWhere(actor, 'email.send', { company: 'companyId' }), { status: 'ACTIVE', OR: [{ verificationStatus: { not: 'SUCCESS' } }, { dkimStatus: { not: 'SUCCESS' } }] }] },
        select: { domain: true, verificationStatus: true, dkimStatus: true, lastCheckedAt: true },
        take: 20,
      })
      for (const identity of identities) {
        const state = identity.verificationStatus !== 'SUCCESS' ? identity.verificationStatus : identity.dkimStatus
        items.push(item('mailDomain', '/admin/connections#mail', { subject: identity.domain, state, since: identity.lastCheckedAt ? toUtcIso(identity.lastCheckedAt) : null, severity: state === 'FAILED' ? 'critical' : 'warning' }))
      }
    }
    if (may('tabletUnseen')) {
      const before = new Date(now.getTime() - TABLET_UNSEEN_DAYS * DAY_MS)
      const devices = await client.device.findMany({
        where: { AND: [scopeWhere(actor, 'devices.view', { company: 'companyId', site: 'siteId' }), { status: 'ACTIVE', OR: [{ lastSeenAt: { lt: before } }, { lastSeenAt: null }] }] },
        select: { id: true, name: true, lastSeenAt: true },
        orderBy: { lastSeenAt: 'asc' },
        take: 20,
      })
      for (const device of devices) {
        items.push(
          item('tabletUnseen', `/admin/devices/${device.id}`, {
            subject: device.name,
            since: device.lastSeenAt ? toUtcIso(device.lastSeenAt) : null,
            days: device.lastSeenAt ? Math.floor((now.getTime() - device.lastSeenAt.getTime()) / DAY_MS) : null,
          }),
        )
      }
    }
    if (may('drill')) {
      const { status } = await drillsOf(client, now, 20)
      if (status.state !== 'ok') {
        items.push(item('drill', '/admin/security#backups', { state: status.state, since: status.lastOn, days: status.daysLeft, severity: status.state === 'due_soon' ? 'warning' : 'critical' }))
      }
    }
    if (may('jobsFailed')) {
      const dead = await client.outboxEvent.count({ where: { status: 'DEAD' } })
      if (dead > 0) items.push(item('jobsFailed', '/admin/security#status', { count: dead, severity: 'critical' }))
    }
    if (may('twoFactorMissing')) {
      const people = await client.roleAssignment.findMany({
        where: { ...liveAssignment(now), role: { audience: 'OFFICE', requireMfa: true }, user: { status: 'ACTIVE', totpConfirmedAt: null } },
        select: { userId: true },
        distinct: ['userId'],
      })
      if (people.length > 0) items.push(item('twoFactorMissing', '/admin/security#sign-in', { count: people.length }))
    }
    const order = (entry: Item) => (entry.severity === 'critical' ? 0 : 1)
    items.sort((a, b) => order(a) - order(b))
    return { asOf: toUtcIso(now), items, unread: ATTENTION_KINDS.filter((kind) => !may(kind)) }
  })
}

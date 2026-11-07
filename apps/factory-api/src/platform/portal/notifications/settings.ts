import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { readUnsubscribeToken } from '@nexus/factory-domain/portal/notifications/mail'
import {
  allNonEssentialOff,
  changeProblems,
  LOCKED_REASON,
  NON_ESSENTIAL_TOPICS,
  rowsOfChange,
  settingsOf,
  TOPIC_WORDS,
  type PartnerEmailFrequency,
  type PartnerEmailTopic,
  type SettingsChange,
} from '@nexus/factory-domain/portal/notifications/topics'
import type { CommandTools, CommandTx } from '../../../core/command'
import { commandOn } from '../tasks/clock'
import { portalSessionOf } from '../../auth/portal/authenticator'
import { assertCsrf } from '../../auth/sessions/cookies'
import { officeAuthOf } from '../../auth/sessions/office-auth'
import { unsubscribeKeyOf } from './mail'

/**
 * A partner person's e-mail settings (B-W2b-167; COL-063, PLT-148; design portal.frame E-mail settings, portal.signin
 * first-visit "E-mail summaries", portal.customer.account › E-mail settings):
 *
 *   GET /portal/email-settings          every topic with how often it is mailed, whether it is locked on (orders, shipped,
 *                                       invoices: "Needed to run your orders") and whether all non-essential mail is off
 *   PUT /portal/email-settings          per topic, and/or one frequency for every non-essential topic (the first visit's
 *                                       summaries; OFF = the "unsubscribe from all non-essential mail" switch)
 *   POST /portal/unsubscribe/preview    public: the mail's signed link (`#token=`) says whose mail it turns off, nothing used
 *   POST /portal/unsubscribe            public (CSRF): turns every non-essential topic of that person off (GDPR)
 *
 * One row per person and topic is the API's (the table has no unique key: plan B-W2b-156 Decided 4): a person's save is
 * serialised with pg_advisory_xact_lock(hashtext(<person>)) and reads before it writes. Only the frequency of a row changes.
 * The settings of the signed-in person only: an office preview has none (403). They work before the first visit (signed in, no
 * permission), so the first visit's summaries are saved with them.
 */

type Client = FactoryClient | CommandTx

const ROW = { id: true, topic: true, frequency: true, version: true, updatedAt: true } as const

/** The person's stored frequencies (the newest row of a topic wins, should two exist). */
export async function preferencesOf(client: Client, userId: string): Promise<Map<PartnerEmailTopic, PartnerEmailFrequency>> {
  const rows = await client.partnerEmailPreference.findMany({ where: { userId }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], select: ROW })
  return new Map(rows.map((row) => [row.topic, row.frequency]))
}

function view(stored: ReadonlyMap<PartnerEmailTopic, PartnerEmailFrequency>) {
  return {
    topics: settingsOf(stored).map((entry) => ({ ...entry, words: TOPIC_WORDS[entry.topic], reason: entry.locked ? LOCKED_REASON : null })),
    nonEssentialOff: allNonEssentialOff(stored),
  }
}

function personOf(request: FastifyRequest) {
  const session = portalSessionOf(request)
  if (session.preview) throw new ForbiddenError('A preview of the portal has no e-mail settings: they are each partner person’s own.')
  return session
}

export async function readSettings(request: FastifyRequest) {
  const session = personOf(request)
  return view(await request.withClient((client) => preferencesOf(client, session.userId)))
}

/** Writes a change of one person's settings inside a command (theirs, or the unsubscribe link's); which topics changed. */
async function writeInCommand(tools: CommandTools, person: { readonly userId: string; readonly partyId: string }, change: SettingsChange, byLink: boolean): Promise<PartnerEmailTopic[]> {
  const { tx, now } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${person.userId}::text))`
  const rows = await tx.partnerEmailPreference.findMany({ where: { userId: person.userId }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], select: ROW })
  const byTopic = new Map(rows.map((row) => [row.topic, row]))
  const changed: PartnerEmailTopic[] = []
  for (const [topic, frequency] of rowsOfChange(change)) {
    const existing = byTopic.get(topic)
    if (existing?.frequency === frequency) continue
    if (existing) {
      await tx.partnerEmailPreference.update({ where: { id: existing.id }, data: { frequency, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    } else {
      await tx.partnerEmailPreference.create({ data: { id: newId(), partyId: person.partyId, userId: person.userId, topic, frequency, createdAt: now, updatedAt: now }, select: { id: true } })
    }
    changed.push(topic)
  }
  // Every save is audited, a save that changes nothing too (it says so); only a change is an event.
  tools.audit({ action: 'portalEmail.settings', recordType: 'User', recordId: person.userId, before: Object.fromEntries(changed.map((topic) => [topic, byTopic.get(topic)?.frequency ?? null])), after: { ...Object.fromEntries(changed.map((topic) => [topic, rowsOfChange(change).get(topic)])), changed: changed.length, byLink } })
  if (changed.length > 0) tools.emit({ type: 'partner_email.settings_changed', subject: person.userId, payload: { userId: person.userId, partyId: person.partyId, topics: changed, byLink } })
  return changed
}

export async function saveSettings(app: FastifyInstance, request: FastifyRequest, body: SettingsChange, idempotencyKey?: string) {
  const session = personOf(request)
  const problems = changeProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  // The partner scope: the person's own party's rows (the database checks the person is a partner user of it).
  await commandOn(app, request, { name: 'portalEmail.settings', idempotencyKey, input: body }, (tools) => writeInCommand(tools, { userId: session.userId, partyId: session.partyId }, body, false))
  return readSettings(request)
}

// --- the unsubscribe link --------------------------------------------------------------------------------------------------------

const mask = (email: string): string => {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`
}

async function personOfToken(app: FastifyInstance, token: unknown) {
  const auth = officeAuthOf(app)
  const reference = readUnsubscribeToken(unsubscribeKeyOf(auth.secrets), token)
  const tenant = reference ? await auth.inPlatform((client) => client.tenant.findUnique({ where: { id: reference.tenantId }, select: { status: true } })) : null
  const person = reference && tenant?.status === 'ACTIVE' ? await auth.inTenant(reference.tenantId, reference.userId, (client) => client.user.findUnique({ where: { id: reference.userId }, select: { id: true, email: true, audience: true, partyId: true } })) : null
  if (!reference || !person || person.audience !== 'PARTNER' || person.partyId === null) throw new NotFoundError('This unsubscribe link no longer works. Manage your e-mails in the portal.')
  return { tenantId: reference.tenantId, userId: person.id, partyId: person.partyId, email: person.email }
}

export async function unsubscribePreview(app: FastifyInstance, token: string) {
  const person = await personOfToken(app, token)
  const stored = await officeAuthOf(app).inTenant(person.tenantId, person.userId, (client) => preferencesOf(client, person.userId))
  return { email: mask(person.email), topics: NON_ESSENTIAL_TOPICS.map((topic) => ({ topic, words: TOPIC_WORDS[topic] })), alreadyOff: allNonEssentialOff(stored), keeps: LOCKED_REASON }
}

export async function unsubscribe(app: FastifyInstance, request: FastifyRequest, token: string) {
  assertCsrf(request)
  const person = await personOfToken(app, token)
  const auth = officeAuthOf(app)
  // The office scope as the person (the link is theirs; no session): every non-essential topic OFF.
  await auth.command(auth.contextFor(request, person.tenantId, person.userId), { name: 'portalEmail.unsubscribe', idempotencyKey: `portal-unsubscribe:${person.userId}:${auth.clock.now().toISOString().slice(0, 16)}`, input: { userId: person.userId } }, (tools) =>
    writeInCommand(tools, { userId: person.userId, partyId: person.partyId }, { nonEssential: 'OFF' }, true),
  )
  return { email: mask(person.email), unsubscribed: true, keeps: LOCKED_REASON }
}

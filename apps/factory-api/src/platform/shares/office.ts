import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { inviteMail, recordLabelOf, SHARE_MAIL_TEMPLATES } from '@nexus/factory-domain/shares/mail'
import { PARTNERS_SHARES_MANAGE, PARTNERS_SHARES_VIEW } from '@nexus/factory-domain/shares/permissions'
import { defaultShareEnd, shareEndProblems, shareLocaleOf, shareNoteProblems, sharePermissionsOf, shareStateOf, type ShareLocale, type SharePermission } from '@nexus/factory-domain/shares/rules'
import { command, type CommandTx } from '../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../core/context'
import { deliverMail, queueMail } from '../approvals-out/mail'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { emailOrThrow } from '../auth/users/email'
import { suppressedAmong } from '../email-out/outbound'
import { systemCallerOf } from '../files/files'
import { assertNoPayByLink } from '../links/pay'
import { resolveRecord, type RecordScope } from '../threads/records'
import { shareRecordOf, type ShareRecordAdapter } from './records'

/**
 * The office's side of inviting a partner to one record (B-W2b-200; COL-061, COL-062; design shell.panels "the record's
 * followers and external participants", links.invite; the record panels' Partners tab):
 *
 *   GET  /shares?recordType&recordId   partners.shares.view + the record's view permission, over its company, site and party:
 *        the record, its partner (the party its thread reaches) with the contacts on file, and every share, newest first.
 *   POST /shares {recordType, recordId, contactId? | email?, permissions, expiresAt?, note?, send, language?}
 *        partners.shares.manage + the record's write permission. The record read in the person's scope; the partner is the
 *        record's own (never another party: its thread and its files reach that party only); one live share per address and
 *        record; the token minted outside; ONE command: the RECORD_INVITE link (expires with the share, its one use never
 *        taken), the share naming it, the audit rows, `record_share.invited` and, with `send`, the QUEUED mail; after the
 *        commit the mail (FAKE locally) or, without `send`, the link ONCE.
 *   PUT  /shares/:shareId/permissions {permissions, version}   a live share: what they may do now (VIEW always). The next use
 *        reads it (platform/links: every request of the link checks the share).
 *   POST /shares/:shareId/revoke {version}   a live share and its link stop together, in one command.
 *
 * A new end date is a new invitation: a link's terms never change (W0), and the database keeps the link's end within the
 * share's.
 */

type Client = FactoryClient | CommandTx

const SHARE_OFFICE = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  partyId: true,
  contactId: true,
  email: true,
  permissions: true,
  notifyByEmail: true,
  expiresAt: true,
  revokedAt: true,
  revokedById: true,
  linkId: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.RecordShareSelect
type ShareRow = Prisma.RecordShareGetPayload<{ select: typeof SHARE_OFFICE }>

function officeOf(request: FastifyRequest): { context: OfficeContext; actor: Actor } {
  const context = requireContext(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  return { context, actor: actorOf(context) }
}

const scopeOf = (scope: RecordScope) => ({ companyId: scope.companyId, ...(scope.siteId ? { siteId: scope.siteId } : {}), ...(scope.partyId ? { partyId: scope.partyId } : {}) })

/** partners.shares.* AND the record's own permission; a person who may not see the shares learns nothing of the record. */
function needs(actor: Actor, adapter: ShareRecordAdapter, scope: RecordScope, mode: 'view' | 'manage'): void {
  const where = scopeOf(scope)
  if (!can(actor, PARTNERS_SHARES_VIEW, where) && !can(actor, PARTNERS_SHARES_MANAGE, where)) throw new NotFoundError('Record not found.')
  if (mode === 'manage' && !can(actor, PARTNERS_SHARES_MANAGE, where)) throw new ForbiddenError(`Inviting a partner to this record needs ${PARTNERS_SHARES_MANAGE}.`)
  if (!can(actor, mode === 'manage' ? adapter.manage : adapter.view, where)) {
    throw new ForbiddenError(mode === 'manage' ? `Inviting a partner to this record needs ${adapter.manage}.` : `Seeing who is invited to this record needs ${adapter.view}.`)
  }
}

/** Why nobody can be invited to the record (a code the screens say in words), or null. */
function heldOf(scope: RecordScope): 'ALL_COMPANIES' | 'NO_PARTY' | null {
  if (scope.companyId === null) return 'ALL_COMPANIES'
  if (scope.partyId === null) return 'NO_PARTY'
  return null
}

const HELD_WORDS = {
  ALL_COMPANIES: 'This record is shared by every company: invite the partner on its quote or order instead.',
  NO_PARTY: 'This record has no customer, supplier, workshop or brand: there is nobody outside to invite.',
} as const

const held = (code: keyof typeof HELD_WORDS): DomainError => new DomainError('invalid_state', HELD_WORDS[code], [{ path: `held/${code}`, message: HELD_WORDS[code] }])
const refusal = (code: string, words: string): DomainError => new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])

/** The record as the office reads it (its scope, its reference); 404 when the person's tenant does not hold it. */
async function recordOf(client: Client, recordType: string, recordId: string, at: 'body' | 'query' = 'body') {
  const adapter = shareRecordOf(recordType)
  if (!adapter) throw new ValidationError('Nobody outside can be invited to this kind of record.', [{ path: `${at}/recordType`, message: 'Not a record a partner can be invited to.' }])
  const scope = isUuid(recordId) ? await resolveRecord(client, recordType, recordId) : null
  const record = scope ? await adapter.read(client, recordId) : null
  if (!scope || !record) throw new NotFoundError('Record not found.')
  return { adapter, scope, record }
}

// ---- what the office reads -----------------------------------------------------------------------------------------------

async function officeViews(client: Client, rows: readonly ShareRow[], now: Date) {
  const people = [...new Set(rows.flatMap((row) => [row.createdById, row.revokedById]).filter((id): id is string => id !== null))]
  const names = new Map((await client.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const contactIds = [...new Set(rows.map((row) => row.contactId).filter((id): id is string => id !== null))]
  const contacts = new Map((await client.partyContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } })).map((contact) => [contact.id, contact.name]))
  const linkIds = rows.map((row) => row.linkId).filter((id): id is string => id !== null)
  const links = new Map((await client.oneOffLink.findMany({ where: { id: { in: linkIds } }, select: { id: true, lastUsedAt: true } })).map((link) => [link.id, link]))
  return rows.map((row) => {
    const state = shareStateOf(row, now)
    const link = row.linkId ? links.get(row.linkId) : undefined
    return {
      id: row.id,
      email: row.email,
      contact: row.contactId ? { id: row.contactId, name: contacts.get(row.contactId) ?? null } : null,
      permissions: sharePermissionsOf(row.permissions),
      notifyByEmail: row.notifyByEmail,
      expiresAt: toUtcIso(row.expiresAt),
      state,
      invitedAt: toUtcIso(row.createdAt),
      invitedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      revoked: row.revokedAt ? { at: toUtcIso(row.revokedAt), byName: row.revokedById ? (names.get(row.revokedById) ?? null) : null } : null,
      lastOpenedAt: link?.lastUsedAt ? toUtcIso(link.lastUsedAt) : null,
      may: { change: state === 'LIVE', revoke: state === 'LIVE' },
      version: row.version,
    }
  })
}

/** GET /shares?recordType&recordId: the record's partner, its contacts on file, and every share (live first, newest first). */
export async function recordShares(request: FastifyRequest, recordType: string, recordId: string) {
  const { actor } = officeOf(request)
  const now = officeAuthOf(request.server).clock.now()
  return request.withClient(async (client) => {
    const { adapter, scope, record } = await recordOf(client, recordType, recordId, 'query')
    needs(actor, adapter, scope, 'view')
    const party = scope.partyId ? await client.party.findUnique({ where: { id: scope.partyId }, select: { id: true, legalName: true, language: true } }) : null
    const contacts = scope.partyId
      ? await client.partyContact.findMany({ where: { partyId: scope.partyId, status: 'ACTIVE', email: { not: null } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, name: true, email: true, language: true } })
      : []
    const rows = await client.recordShare.findMany({ where: { recordType, recordId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, select: SHARE_OFFICE })
    const views = await officeViews(client, rows, now)
    const order = (state: string) => (state === 'LIVE' ? 0 : 1)
    return {
      record: { type: recordType, id: recordId, reference: record.reference },
      party: party ? { id: party.id, name: party.legalName, language: shareLocaleOf(party.language) } : null,
      contacts: contacts.map((contact) => ({ id: contact.id, name: contact.name, email: contact.email!.trim().toLowerCase(), language: contact.language ? shareLocaleOf(contact.language) : null })),
      held: heldOf(scope),
      may: { invite: heldOf(scope) === null && can(actor, PARTNERS_SHARES_MANAGE, scopeOf(scope)) && can(actor, adapter.manage, scopeOf(scope)) },
      shares: views.sort((a, b) => order(a.state) - order(b.state)),
    }
  })
}

// ---- invite ----------------------------------------------------------------------------------------------------------------

export interface InviteBody {
  readonly recordType: string
  readonly recordId: string
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly permissions: readonly SharePermission[]
  readonly expiresAt?: string | undefined
  readonly note?: string | null | undefined
  readonly send: boolean
  readonly language?: ShareLocale | undefined
}

const fail = (issues: Issue[], what: string): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : what, issues)

/** POST /shares. */
export async function inviteToRecord(request: FastifyRequest, body: InviteBody, idempotencyKey?: string) {
  const { context, actor } = officeOf(request)
  const auth = officeAuthOf(request.server)
  const now = auth.clock.now()
  const facts = await request.withClient(async (client) => {
    const { adapter, scope, record } = await recordOf(client, body.recordType, body.recordId)
    needs(actor, adapter, scope, 'manage')
    const code = heldOf(scope)
    if (code) throw held(code)
    const contact = body.contactId && isUuid(body.contactId) ? await client.partyContact.findFirst({ where: { id: body.contactId, partyId: scope.partyId!, status: 'ACTIVE' }, select: { id: true, name: true, email: true, language: true } }) : null
    const party = await client.party.findUnique({ where: { id: scope.partyId! }, select: { language: true } })
    const company = await client.company.findUnique({ where: { id: scope.companyId! }, select: { legalName: true, tradeName: true } })
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { adapter, scope, record, contact, party, company, user }
  })
  const companyId = facts.scope.companyId!
  const partyId = facts.scope.partyId!

  const problems: Issue[] = []
  if (body.contactId && !facts.contact?.email) problems.push({ path: 'body/contactId', message: 'Not an active contact of this partner with an e-mail.' })
  if (!body.contactId && !body.email) problems.push({ path: 'body/email', message: 'The address the invitation goes to.' })
  const expiresAt = body.expiresAt === undefined ? defaultShareEnd(now) : parseInstant(body.expiresAt)
  problems.push(...(expiresAt ? shareEndProblems(expiresAt, now) : [{ path: 'body/expiresAt', message: 'Until when: an instant.' }]), ...shareNoteProblems(body.note))
  if (problems.length > 0) throw fail(problems, 'The invitation is not complete.')
  const to = facts.contact?.email?.trim().toLowerCase() ?? emailOrThrow(body.email!, 'body/email')
  const permissions = sharePermissionsOf(body.permissions)
  const locale: ShareLocale = body.language ?? shareLocaleOf(facts.contact?.language ?? facts.party?.language)
  const note = body.note?.trim() || null

  // Outside the command: the link's token (never stored, only its hash).
  const shareId = newId()
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId, linkId })
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const sender = facts.user ? { userId: context.actorId, name: facts.user.displayName, email: facts.user.email } : null
  const label = recordLabelOf(body.recordType, facts.record.reference, locale)
  const mailFacts = { companyName, inviterName: sender?.name ?? null, label, permissions, expiresAt: expiresAt!, note }

  const { result, replayed } = await command(request, { name: 'partners.shares.invite', idempotencyKey, input: { ...body, shareId } }, async (tools) => {
    const { tx, now: at } = tools
    const again = await resolveRecord(tx, body.recordType, body.recordId)
    if (!again || again.partyId !== partyId || again.companyId !== companyId) throw new NotFoundError('Record not found.')
    const live = await tx.recordShare.count({ where: { recordType: body.recordType, recordId: body.recordId, email: to, revokedAt: null, expiresAt: { gt: at } } })
    if (live > 0) throw refusal('ALREADY_INVITED', 'This address is invited to this record already: change what they may do, or revoke it first.')
    await assertNoPayByLink(tx, { recordType: body.recordType, recordId: body.recordId })
    if (body.send && (await suppressedAmong(tx, [to])).size > 0) throw refusal('SUPPRESSED', 'This address bounced or complained: correct it first.')
    // The link first (the share names it), expiring with the share; its one use is never taken (RECORD_INVITE counts nothing).
    await tx.oneOffLink.createMany({
      data: [{ id: linkId, companyId, partyId, purpose: 'RECORD_INVITE', recordType: body.recordType, recordId: body.recordId, tokenHash: linkTokenHash(token.value), email: to, expiresAt: expiresAt!, maxUses: 1, contactId: facts.contact?.id ?? null, createdAt: at, updatedAt: at, createdById: context.actorId }],
    })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId, after: { purpose: 'RECORD_INVITE', recordType: body.recordType, recordId: body.recordId, partyId, email: to, expiresAt: toUtcIso(expiresAt!), maxUses: 1 } })
    await tx.recordShare.create({
      data: { id: shareId, companyId, recordType: body.recordType, recordId: body.recordId, partyId, contactId: facts.contact?.id ?? null, email: to, permissions, expiresAt: expiresAt!, linkId, createdAt: at, updatedAt: at, createdById: context.actorId },
      select: { id: true },
    })
    const outboundId = body.send ? await queueMail(tools, { companyId, record: { type: 'OneOffLink', id: linkId }, template: SHARE_MAIL_TEMPLATES.invite, to, locale, subject: inviteMail(locale, mailFacts, '').subject, sender }) : null
    tools.audit({ recordType: 'RecordShare', recordId: shareId, companyId, siteId: facts.scope.siteId, after: { recordType: body.recordType, recordId: body.recordId, partyId, contactId: facts.contact?.id ?? null, permissions, expiresAt: toUtcIso(expiresAt!), linkId, mailed: outboundId !== null } })
    tools.emit({ type: 'record_share.invited', subject: shareId, companyId, payload: { shareId, recordType: body.recordType, recordId: body.recordId, partyId, linkId, permissions, expiresAt: toUtcIso(expiresAt!), mailed: outboundId !== null } })
    return { shareId, outboundId }
  })
  const share = await shareView(request, result.shareId, now)
  if (replayed) return { share, url: null, delivery: null }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { share, url, delivery: null }
  const delivery = await deliverMail(systemCallerOf(request)(context.tenantId), result.outboundId, inviteMail(locale, mailFacts, url).body, sender?.name ?? null, auth.clock)
  return { share, url: null, delivery }
}

async function shareView(request: FastifyRequest, shareId: string, now: Date) {
  return request.withClient(async (client) => {
    const row = await client.recordShare.findUnique({ where: { id: shareId }, select: SHARE_OFFICE })
    if (!row) throw new NotFoundError('Invitation not found.')
    return (await officeViews(client, [row], now))[0]!
  })
}

// ---- change, revoke --------------------------------------------------------------------------------------------------------

/** The share as the office reads it, its record checked for the person (manage), or 404. */
async function ownShare(request: FastifyRequest, shareId: string) {
  const { actor } = officeOf(request)
  const row = isUuid(shareId) ? await request.withClient((client) => client.recordShare.findUnique({ where: { id: shareId }, select: SHARE_OFFICE })) : null
  if (!row) throw new NotFoundError('Invitation not found.')
  const { adapter, scope } = await request.withClient((client) => recordOf(client, row.recordType, row.recordId))
  needs(actor, adapter, scope, 'manage')
  return row
}

/** Locks the share (FOR UPDATE), checks the version and that it still lives. */
async function lockLive(tx: CommandTx, shareId: string, version: number, now: Date): Promise<ShareRow> {
  await tx.$queryRaw`SELECT id FROM "RecordShare" WHERE id = ${shareId}::uuid FOR UPDATE`
  const row = await tx.recordShare.findUnique({ where: { id: shareId }, select: SHARE_OFFICE })
  if (!row) throw new NotFoundError('Invitation not found.')
  if (row.version !== version) throw refusal('STALE', 'Someone changed this invitation a moment ago: read it again.')
  const state = shareStateOf(row, now)
  if (state !== 'LIVE') throw new DomainError('invalid_state', state === 'REVOKED' ? 'This invitation was revoked already.' : 'This invitation has ended.', [{ path: `held/${state}`, message: state }])
  return row
}

/** PUT /shares/:shareId/permissions. */
export async function changeSharePermissions(request: FastifyRequest, shareId: string, body: { readonly permissions: readonly SharePermission[]; readonly version: number }, idempotencyKey?: string) {
  const row = await ownShare(request, shareId)
  const permissions = sharePermissionsOf(body.permissions)
  await command(request, { name: 'partners.shares.change', idempotencyKey, input: { shareId, ...body } }, async (tools) => {
    const current = await lockLive(tools.tx, shareId, body.version, tools.now)
    await tools.tx.recordShare.update({ where: { id: shareId }, data: { permissions, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'RecordShare', recordId: shareId, companyId: current.companyId, before: { permissions: sharePermissionsOf(current.permissions) }, after: { permissions } })
    tools.emit({ type: 'record_share.changed', subject: shareId, companyId: current.companyId, payload: { shareId, recordType: current.recordType, recordId: current.recordId, partyId: current.partyId, permissions, notifyByEmail: current.notifyByEmail, by: 'OFFICE' } })
    return null
  })
  return { share: await shareView(request, row.id, officeAuthOf(request.server).clock.now()) }
}

/** POST /shares/:shareId/revoke. */
export async function revokeShare(request: FastifyRequest, shareId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context } = officeOf(request)
  const row = await ownShare(request, shareId)
  await command(request, { name: 'partners.shares.revoke', idempotencyKey, input: { shareId, ...body } }, async (tools) => {
    const current = await lockLive(tools.tx, shareId, body.version, tools.now)
    await tools.tx.recordShare.update({ where: { id: shareId }, data: { revokedAt: tools.now, revokedById: context.actorId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    // The share and its link stop together (the database does not revoke the link by itself).
    if (current.linkId) {
      const { count } = await tools.tx.oneOffLink.updateMany({ where: { id: current.linkId, revokedAt: null }, data: { revokedAt: tools.now, revokedById: context.actorId } })
      if (count > 0) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: current.linkId, companyId: current.companyId, after: { revokedAt: toUtcIso(tools.now), shareId } })
    }
    tools.audit({ recordType: 'RecordShare', recordId: shareId, companyId: current.companyId, before: { state: 'LIVE' }, after: { state: 'REVOKED', linkId: current.linkId } })
    tools.emit({ type: 'record_share.revoked', subject: shareId, companyId: current.companyId, payload: { shareId, recordType: current.recordType, recordId: current.recordId, partyId: current.partyId, linkId: current.linkId } })
    return null
  })
  return { share: await shareView(request, row.id, officeAuthOf(request.server).clock.now()) }
}

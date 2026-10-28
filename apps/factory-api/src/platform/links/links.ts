import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LINKS_MANAGE, LINKS_VIEW } from '@nexus/factory-domain/links/permissions'
import { linkState, linkTerms, PURPOSE_RULES, type LinkPurpose } from '@nexus/factory-domain/links/purposes'
import { mintLinkToken, linkTokenHash } from '@nexus/factory-domain/links/token'
import type { CommandTx } from '../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../core/context'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { emailOrThrow } from '../auth/users/email'
import type { LinkView } from './contract'
import { linkRecordSource } from './records'
import { linkCommand } from './use'

/**
 * The office side of one-off links (plan A1 §3.10 "Links"; feature SAL-099): make one for a record, list a record's
 * links with their evidence, revoke one. Writes go through command() with their audit rows.
 *
 *   make     links.manage over the record's company and party. The record comes from its module's source (records.ts),
 *            read inside the command: it names the company, the party and the default address. The purpose decides
 *            the default expiry and use limit and their maxima (factory-domain links/purposes). The token is minted
 *            OUTSIDE the command and only its hash goes in: the command's result (which an Idempotency-Key receipt
 *            stores) never holds it. The answer shows the URL this once; a repeated request answers url null.
 *   list     links.view: a record's links that the caller's grants reach (company and party), newest first.
 *   revoke   links.manage: final; the link opens nothing from then on (its evidence stays).
 */

const SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  purpose: true,
  recordType: true,
  recordId: true,
  email: true,
  note: true,
  expiresAt: true,
  maxUses: true,
  uses: true,
  lastUsedAt: true,
  revokedAt: true,
  version: true,
  createdAt: true,
  createdById: true,
  evidence: {
    select: { id: true, action: true, useNumber: true, typedName: true, emailCheck: true, at: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.OneOffLinkSelect

type LinkRow = Prisma.OneOffLinkGetPayload<{ select: typeof SELECT }>

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

export function linkViewOf(row: LinkRow, now: Date): LinkView {
  return {
    id: row.id,
    companyId: row.companyId,
    partyId: row.partyId,
    purpose: row.purpose,
    recordType: row.recordType,
    recordId: row.recordId,
    email: row.email,
    note: row.note,
    state: linkState(row, now),
    expiresAt: toUtcIso(row.expiresAt),
    maxUses: row.maxUses,
    uses: row.uses,
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    evidence: row.evidence.map((entry) => ({
      id: entry.id,
      action: entry.action,
      useNumber: entry.useNumber,
      typedName: entry.typedName,
      emailCheck: entry.emailCheck,
      at: toUtcIso(entry.at),
    })),
  }
}

const loadLink = async (client: CommandTx | FactoryClient, id: string): Promise<LinkRow> => {
  const row = await client.oneOffLink.findUnique({ where: { id }, select: SELECT })
  if (!row) throw new NotFoundError('Link not found.')
  return row
}

export interface CreateLinkInput {
  readonly purpose: LinkPurpose
  readonly recordType: string
  readonly recordId: string
  readonly email?: string | null | undefined
  readonly note?: string | undefined
  readonly expiresInDays?: number | undefined
  readonly maxUses?: number | undefined
}

/** links.create: a new link for a record (see above). Returns the link and, the first time only, its URL. */
export async function createLink(request: FastifyRequest, body: CreateLinkInput, idempotencyKey?: string): Promise<{ link: LinkView; url: string | null }> {
  const context = requireContext(request) as OfficeContext
  const auth = officeAuthOf(request.server)
  const rule = PURPOSE_RULES[body.purpose]
  if (!rule.recordTypes.includes(body.recordType)) {
    throw new ValidationError('This purpose does not open that kind of record.', [
      { path: 'recordType', message: `A ${body.purpose} link opens a ${rule.recordTypes.join(' or ')}.` },
    ])
  }
  const source = linkRecordSource(body.recordType)
  if (!source) throw new InvalidStateError(`Links to a ${body.recordType} cannot be made yet: its module does not offer them.`)
  const email = body.email === undefined ? undefined : body.email === null ? null : emailOrThrow(body.email)

  const linkId = newId()
  // Minted here, outside the command: only its hash enters the transaction, so no receipt or audit row can hold it.
  let minted: { readonly value: string; readonly partyId: string } | null = null

  const { result, replayed } = await linkCommand(request, { name: 'links.create', idempotencyKey, input: body }, async ({ tx, now, audit }) => {
    const record = await source.read(tx, body.recordId)
    if (!record) throw new NotFoundError(`${body.recordType} not found.`)
    if (!can(actorOf(context), LINKS_MANAGE, { companyId: record.companyId, partyId: record.partyId })) throw new ForbiddenError()
    const terms = linkTerms(body.purpose, body, now)
    const to = email !== undefined ? email : record.email ? emailOrThrow(record.email) : null
    const token = mintLinkToken({ tenantId: context.tenantId, partyId: record.partyId, linkId })
    minted = { value: token.value, partyId: record.partyId }
    await tx.oneOffLink.createMany({
      data: [
        {
          id: linkId,
          companyId: record.companyId,
          partyId: record.partyId,
          purpose: body.purpose,
          recordType: body.recordType,
          recordId: body.recordId,
          tokenHash: linkTokenHash(token.value),
          email: to,
          note: body.note ?? null,
          expiresAt: terms.expiresAt,
          maxUses: terms.maxUses,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
      ],
    })
    audit({
      recordType: 'OneOffLink',
      recordId: linkId,
      companyId: record.companyId,
      after: {
        purpose: body.purpose,
        recordType: body.recordType,
        recordId: body.recordId,
        partyId: record.partyId,
        email: to,
        expiresAt: toUtcIso(terms.expiresAt),
        maxUses: terms.maxUses,
      },
    })
    return { link: linkViewOf(await loadLink(tx, linkId), now) }
  })
  const token = minted as { readonly value: string } | null
  return { link: result.link, url: replayed || token === null ? null : auth.link('/l', token.value) }
}

/** A record's links that the caller's links.view grants reach (company and party), newest first, with their evidence. */
export async function listLinks(client: FactoryClient, actor: Actor, filter: { recordType: string; recordId: string }, now: Date): Promise<LinkView[]> {
  const scope = scopeWhere(actor, LINKS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.OneOffLinkWhereInput
  const rows = await client.oneOffLink.findMany({
    where: { AND: [scope, { recordType: filter.recordType, recordId: filter.recordId }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: SELECT,
  })
  return rows.map((row) => linkViewOf(row, now))
}

/** links.revoke: the link opens nothing from now on. Final; its evidence stays. */
export async function revokeLink(
  request: FastifyRequest,
  linkId: string,
  body: { readonly version?: number | undefined; readonly reason?: string | undefined },
  idempotencyKey?: string,
): Promise<LinkView> {
  const context = requireContext(request) as OfficeContext
  const found = await request.withClient((client) => client.oneOffLink.findUnique({ where: { id: linkId }, select: { companyId: true, partyId: true, revokedAt: true } }))
  if (!found) throw new NotFoundError('Link not found.')
  if (!can(actorOf(context), LINKS_MANAGE, { companyId: found.companyId, partyId: found.partyId })) throw new ForbiddenError()
  if (found.revokedAt !== null) throw new InvalidStateError('This link is already revoked.')

  const { result } = await linkCommand(
    request,
    { name: 'links.revoke', idempotencyKey, input: { linkId, reason: body.reason ?? null }, record: { type: 'OneOffLink', id: linkId, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async ({ tx, now, audit }) => {
      const { count } = await tx.oneOffLink.updateMany({ where: { id: linkId, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
      if (count !== 1) throw new InvalidStateError('This link is already revoked.')
      audit({ recordType: 'OneOffLink', recordId: linkId, companyId: found.companyId, after: { revokedAt: toUtcIso(now) }, ...(body.reason ? { reason: body.reason } : {}) })
      return linkViewOf(await loadLink(tx, linkId), now)
    },
  )
  return result
}

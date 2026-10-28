import type { Prisma } from '@nexus/factory-db'
import { EMAIL_MANAGE, EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { domainOf, identityReady, isAddress, type DisplayNamePolicy, type IdentityKind, type IdentityStatus } from '@nexus/factory-domain/email/rules'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { contextOf } from '../threads/threads'
import type { IdentityView } from './contract'
import type { IdentityState } from './port'
import type { EmailRuntime } from './service'

/**
 * A company's sending identities (plan A1 §3.7 "Domains"; features PLT-230, COL-024; research 03: per-company sending
 * identity on its own domain). Office admins with email.manage (a step-up permission: the routes ask for a fresh code)
 * add one for a company's domain, refresh its SES state, and change its From-line policy, default flag and status; the
 * people who send (email.send) list them. Adding one asks SES to verify the domain with Easy DKIM (one gateway call,
 * `mail.create_identity`): the answer names three CNAME records to publish; a check (`mail.get_identity`) reads the
 * state again. A FAKE account's identity verifies at once. The full set-up wizard with live DNS checks (SPF, DMARC, MX
 * for the reply domain) is the admin screen of PLT-230, later.
 */

const IDENTITY_VIEW = {
  id: true,
  companyId: true,
  kind: true,
  domain: true,
  fromAddress: true,
  displayName: true,
  displayNamePolicy: true,
  replyDomain: true,
  accountId: true,
  sesIdentityArn: true,
  verificationStatus: true,
  dkimStatus: true,
  dkimTokens: true,
  lastCheckedAt: true,
  isDefault: true,
  status: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.EmailIdentitySelect
type IdentityRow = Prisma.EmailIdentityGetPayload<{ select: typeof IDENTITY_VIEW }>

export function identityViewOf(row: IdentityRow): IdentityView {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    domain: row.domain,
    fromAddress: row.fromAddress,
    displayName: row.displayName,
    displayNamePolicy: row.displayNamePolicy,
    replyDomain: row.replyDomain,
    accountId: row.accountId,
    sesIdentityArn: row.sesIdentityArn,
    verificationStatus: row.verificationStatus,
    dkimStatus: row.dkimStatus,
    dkimRecords: row.dkimTokens.map((token) => ({ type: 'CNAME' as const, name: `${token}._domainkey.${row.domain}`, value: `${token}.dkim.amazonses.com` })),
    ready: identityReady(row),
    lastCheckedAt: row.lastCheckedAt ? toUtcIso(row.lastCheckedAt) : null,
    isDefault: row.isDefault,
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

function officeActor(caller: CommandCaller) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return { context, actor: actorOf(context) }
}

/** GET /email/identities (email.send): the sending identities of the companies the caller sends for. */
export async function listIdentities(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const { actor } = officeActor(caller)
  const rows = await caller.withClient((client) =>
    client.emailIdentity.findMany({
      where: { AND: [scopeWhere(actor, EMAIL_SEND, { company: 'companyId' }) as Prisma.EmailIdentityWhereInput, query.companyId ? { companyId: query.companyId } : {}] },
      orderBy: [{ companyId: 'asc' }, { kind: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: IDENTITY_VIEW,
    }),
  )
  return { identities: rows.map(identityViewOf) }
}

/** Makes this identity the only default of its company and kind (inside the command). */
async function onlyDefault(tx: CommandTx, row: { readonly id: string; readonly companyId: string; readonly kind: IdentityKind }): Promise<number> {
  const { count } = await tx.emailIdentity.updateMany({ where: { companyId: row.companyId, kind: row.kind, isDefault: true, id: { not: row.id } }, data: { isDefault: false } })
  return count
}

/** Records what SES said of an identity (its own command). */
async function recordState(caller: CommandCaller, identityId: string, state: IdentityState): Promise<IdentityView> {
  const { result } = await command(caller, { name: 'email.recordIdentity', input: { identityId } }, async ({ tx, now, audit }) => {
    const before = await tx.emailIdentity.findUniqueOrThrow({ where: { id: identityId }, select: { companyId: true, verificationStatus: true, dkimStatus: true } })
    const row = await tx.emailIdentity.update({
      where: { id: identityId },
      data: { sesIdentityArn: state.arn, verificationStatus: state.verificationStatus, dkimStatus: state.dkimStatus, dkimTokens: [...state.dkimTokens], lastCheckedAt: now },
      select: IDENTITY_VIEW,
    })
    audit({
      recordType: 'EmailIdentity',
      recordId: identityId,
      companyId: before.companyId,
      before: { verificationStatus: before.verificationStatus, dkimStatus: before.dkimStatus },
      after: { verificationStatus: row.verificationStatus, dkimStatus: row.dkimStatus },
    })
    return identityViewOf(row)
  })
  return result
}

export interface CreateIdentityBody {
  readonly companyId: string
  readonly kind: IdentityKind
  readonly domain: string
  readonly localPart?: string | undefined
  readonly displayName?: string | undefined
  readonly displayNamePolicy?: DisplayNamePolicy | undefined
  readonly replyDomain?: string | undefined
  readonly accountId: string
  readonly isDefault?: boolean | undefined
}

/** POST /email/identities (email.manage, step-up): a new sending identity, then SES asked to verify its domain. */
export async function createIdentity(runtime: EmailRuntime, caller: CommandCaller, body: CreateIdentityBody, idempotencyKey?: string): Promise<{ identity: IdentityView; sesChecked: boolean }> {
  const { context, actor } = officeActor(caller)
  if (!can(actor, EMAIL_MANAGE, { companyId: body.companyId })) throw new ForbiddenError()
  const domain = domainOf(body.domain)
  const replyDomain = domainOf(body.replyDomain ?? `reply.${body.domain}`)
  const localPart = (body.localPart ?? 'noreply').trim().toLowerCase()
  const fromAddress = `${localPart}@${domain ?? ''}`
  const issues = [
    ...(domain ? [] : [{ path: 'body/domain', message: 'Not a domain name.' }]),
    ...(replyDomain ? [] : [{ path: 'body/replyDomain', message: 'Not a domain name.' }]),
    ...(domain && !isAddress(fromAddress) ? [{ path: 'body/localPart', message: 'Not the local part of an address.' }] : []),
  ]
  if (issues.length > 0) throw new ValidationError('The sending identity is not valid.', issues)

  const { result } = await command(caller, { name: 'email.createIdentity', idempotencyKey, input: body }, async ({ tx, now, audit }) => {
    const company = await tx.company.findUnique({ where: { id: body.companyId }, select: { legalName: true, tradeName: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const account = await tx.integrationAccount.findFirst({ where: { id: body.accountId, provider: 'SES', OR: [{ companyId: null }, { companyId: body.companyId }] }, select: { id: true } })
    if (!account) throw new ValidationError('The sending identity is not valid.', [{ path: 'body/accountId', message: 'Not an SES account of this company or of the tenant.' }])
    const taken = await tx.emailIdentity.findFirst({ where: { companyId: body.companyId, fromAddress }, select: { id: true } })
    if (taken) throw new ValidationError('The sending identity is not valid.', [{ path: 'body/localPart', message: 'This company already sends from this address.' }])
    const hasDefault = await tx.emailIdentity.count({ where: { companyId: body.companyId, kind: body.kind, isDefault: true } })
    const id = newId()
    const isDefault = body.isDefault ?? hasDefault === 0
    const row = await tx.emailIdentity.create({
      data: {
        id,
        companyId: body.companyId,
        kind: body.kind,
        domain: domain!,
        fromAddress,
        displayName: body.displayName ?? company.tradeName ?? company.legalName,
        displayNamePolicy: body.displayNamePolicy ?? (body.kind === 'NOTIFICATION' ? 'COMPANY' : 'PERSON_VIA_COMPANY'),
        replyDomain: replyDomain!,
        accountId: account.id,
        isDefault,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: IDENTITY_VIEW,
    })
    const cleared = isDefault ? await onlyDefault(tx, row) : 0
    audit({ recordType: 'EmailIdentity', recordId: id, companyId: body.companyId, after: { kind: row.kind, domain: row.domain, fromAddress, displayNamePolicy: row.displayNamePolicy, isDefault, defaultsCleared: cleared } })
    return { id, domain: row.domain, accountId: row.accountId }
  })

  // SES is asked after the row exists (never inside a transaction); a failure leaves the identity NOT_STARTED for a check.
  try {
    const state = await runtime.mail.createIdentity(caller, result.accountId, result.domain)
    return { identity: await recordState(caller, result.id, state), sesChecked: true }
  } catch {
    const row = await caller.withClient((client) => client.emailIdentity.findUniqueOrThrow({ where: { id: result.id }, select: IDENTITY_VIEW }))
    return { identity: identityViewOf(row), sesChecked: false }
  }
}

async function readIdentity(caller: CommandCaller, identityId: string): Promise<IdentityRow> {
  const { actor } = officeActor(caller)
  const row = await caller.withClient((client) => client.emailIdentity.findUnique({ where: { id: identityId }, select: IDENTITY_VIEW }))
  if (!row || !can(actor, EMAIL_SEND, { companyId: row.companyId })) throw new NotFoundError('Sending identity not found.')
  if (!can(actor, EMAIL_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
  return row
}

/** POST /email/identities/:id/check (email.manage, step-up): SES's verification and DKIM state, read again. */
export async function checkIdentity(runtime: EmailRuntime, caller: CommandCaller, identityId: string): Promise<{ identity: IdentityView }> {
  const row = await readIdentity(caller, identityId)
  const state = await runtime.mail.getIdentity(caller, row.accountId, row.domain)
  return { identity: await recordState(caller, identityId, state) }
}

/** PUT /email/identities/:id (email.manage, step-up): the From-line policy, the name shown, the default flag, the status. */
export async function updateIdentity(
  caller: CommandCaller,
  identityId: string,
  body: { readonly version: number; readonly displayName?: string | undefined; readonly displayNamePolicy?: DisplayNamePolicy | undefined; readonly isDefault?: boolean | undefined; readonly status?: IdentityStatus | undefined },
  idempotencyKey?: string,
): Promise<{ identity: IdentityView }> {
  await readIdentity(caller, identityId)
  const { result } = await command(
    caller,
    { name: 'email.updateIdentity', idempotencyKey, input: { identityId, ...body }, record: { type: 'EmailIdentity', id: identityId, expectedVersion: body.version } },
    async ({ tx, audit }) => {
      const before = await tx.emailIdentity.findUniqueOrThrow({ where: { id: identityId }, select: IDENTITY_VIEW })
      const isDefault = body.status === 'DISABLED' ? false : (body.isDefault ?? before.isDefault)
      const row = await tx.emailIdentity.update({
        where: { id: identityId },
        data: {
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.displayNamePolicy !== undefined ? { displayNamePolicy: body.displayNamePolicy } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          isDefault,
        },
        select: IDENTITY_VIEW,
      })
      const cleared = isDefault && !before.isDefault ? await onlyDefault(tx, row) : 0
      audit({
        recordType: 'EmailIdentity',
        recordId: identityId,
        companyId: row.companyId,
        before: { displayName: before.displayName, displayNamePolicy: before.displayNamePolicy, isDefault: before.isDefault, status: before.status },
        after: { displayName: row.displayName, displayNamePolicy: row.displayNamePolicy, isDefault: row.isDefault, status: row.status, defaultsCleared: cleared },
      })
      return identityViewOf(row)
    },
  )
  return { identity: result }
}

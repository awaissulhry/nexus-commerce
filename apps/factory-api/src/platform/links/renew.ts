import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { linkFilesMail } from '@nexus/factory-domain/links/mail'
import { isLinkPurpose, linkState, PURPOSE_RULES, type LinkPurpose } from '@nexus/factory-domain/links/purposes'
import { fileRenewalRefusal, LINK_RENEW_COALESCE_MS, renewalTerms } from '@nexus/factory-domain/links/renew'
import { linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from '@nexus/factory-domain/links/token'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../core/context'
import { officeAuthOf } from '../auth/sessions/office-auth'
import type { EmailRuntime } from '../email-out/service'
import { systemContext } from '../outbox/system'
import { LINK_HEADER } from './authenticator'
import { deliverLinkMail, LINK_MAIL_TEMPLATES, queueLinkMail } from './mail'
import { payProblemOf } from './pay'
import { linkCommand } from './use'

/**
 * "Ask for a new link" for every purpose (B-W2b-163; factory-domain links/renew; design links.frame): public `POST
 * /link/renew` with the dead link's token in x-factory-link answers ONE thing at once (routes.ts), and this work runs
 * after the answer (officeAuth afterAnswer). Every refusal is silent; the outcome is logged by its code only.
 *
 *   1. the token parses and names an ACTIVE tenant; the link is read in that tenant's system scope; its hash and party
 *      match the token (constant time). Else NOT_A_TOKEN / UNKNOWN.
 *   2. a module renewer for the link's purpose and record type (registerLinkRenewer; W1's two below) decides and sends.
 *   3. else a set of files (purpose renewal `files`) is renewed here (renewFileLink); any other purpose: NO_RENEWER
 *      until its module registers one (it knows whether its record still waits for an answer).
 *
 * The abuse guard holds the route (policy links.renew); a token that names nothing counts as a failure there.
 */

/** A module's renewer: the work after the answer, its outcome code for the log. */
export type LinkRenewer = (email: EmailRuntime, request: FastifyRequest, header: unknown) => Promise<string>

const renewers = new Map<string, LinkRenewer>()
const keyOf = (purpose: string, recordType: string): string => `${purpose}|${recordType}`

/**
 * W1's renewers, which kept their own public routes (B-W1-49, B-W1-31): loaded when first asked, so this platform file
 * does not load those modules (nor they it) at start.
 */
const W1_RENEWERS: Readonly<Record<string, () => Promise<LinkRenewer>>> = {
  [keyOf('DOCUMENT_VIEW', 'Shipment')]: async () => (await import('../../modules/shipping/documents/link')).renewDocumentLink,
  [keyOf('PO_CONFIRM', 'PurchaseOrder')]: async () => (await import('../../modules/purchasing/confirm/renew')).renewConfirmLink,
}

/** A module renews its own links of a purpose and record type (when its routes load). Returns the withdraw (tests). */
export function registerLinkRenewer(purpose: LinkPurpose, recordType: string, renewer: LinkRenewer): () => void {
  const key = keyOf(purpose, recordType)
  if (!PURPOSE_RULES[purpose].recordTypes.includes(recordType)) throw new Error(`No ${purpose} link opens a ${recordType}.`)
  if (renewers.has(key) || key in W1_RENEWERS) throw new Error(`A link renewer for ${key} is registered twice.`)
  renewers.set(key, renewer)
  return () => {
    if (renewers.get(key) === renewer) renewers.delete(key)
  }
}

async function renewerOf(purpose: string, recordType: string): Promise<LinkRenewer | null> {
  const key = keyOf(purpose, recordType)
  return renewers.get(key) ?? (W1_RENEWERS[key] ? await W1_RENEWERS[key]!() : null)
}

/** A view of the request in another context: `withClient` and command() follow it. */
function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

const LINK_FACTS = {
  id: true,
  companyId: true,
  partyId: true,
  purpose: true,
  recordType: true,
  recordId: true,
  tokenHash: true,
  email: true,
  note: true,
  contactId: true,
  passwordHash: true,
  expiresAt: true,
  maxUses: true,
  uses: true,
  revokedAt: true,
  createdAt: true,
} as const satisfies Prisma.OneOffLinkSelect

/** The work behind "Ask for a new link" (see above). */
export async function renewLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const requestId = String(request.id)
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
  const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return 'UNKNOWN'
  const system = asContext(request, systemContext(token.tenantId, requestId))
  const link = await system.withClient((client) => client.oneOffLink.findUnique({ where: { id: token.linkId }, select: LINK_FACTS }))
  if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash) || !isLinkPurpose(link.purpose)) return 'UNKNOWN'

  const renewer = await renewerOf(link.purpose, link.recordType)
  if (renewer) return renewer(email, request, header)
  if (PURPOSE_RULES[link.purpose].renewal !== 'files') return 'NO_RENEWER'
  return renewFileLink(email, system, { ...link, purpose: link.purpose })
}

type DeadLink = Prisma.OneOffLinkGetPayload<{ select: typeof LINK_FACTS }> & { readonly purpose: LinkPurpose }

const normal = (value: string): string => value.trim().toLowerCase()
/** A set of files as one comparable value (order aside). */
const sameSet = (fileIds: readonly string[]): string => [...new Set(fileIds)].sort().join(',')

/** A dead set of files renewed (factory-domain links/renew), as the tenant's system. */
async function renewFileLink(email: EmailRuntime, system: FastifyRequest, link: DeadLink): Promise<string> {
  const auth = officeAuthOf(system.server)
  const now = auth.clock.now()
  const facts = await system.withClient(async (client) => {
    const files = await client.linkFile.findMany({ where: { linkId: link.id }, orderBy: { position: 'asc' }, select: { fileId: true, file: { select: { status: true, originalName: true } } } })
    const address = link.email ? normal(link.email) : null
    const contacts = address
      ? await client.partyContact.findMany({ where: { partyId: link.partyId, status: 'ACTIVE', ...(link.contactId ? { id: link.contactId } : {}) }, select: { id: true, email: true, language: true } })
      : []
    const onFile = contacts.filter((contact) => contact.email !== null && normal(contact.email) === address)
    // The other links of the same files (same record, purpose, address and set: a link sharing more or fewer files is
    // another share), and the renewals of this one.
    const sameRecord = address
      ? await client.oneOffLink.findMany({
          where: { recordType: link.recordType, recordId: link.recordId, purpose: link.purpose, email: address, id: { not: link.id } },
          select: { expiresAt: true, revokedAt: true, uses: true, maxUses: true, createdAt: true, renewalOfId: true, files: { select: { fileId: true } } },
        })
      : []
    const set = sameSet(files.map((entry) => entry.fileId))
    const siblings = sameRecord.filter((row) => row.renewalOfId === link.id || sameSet(row.files.map((entry) => entry.fileId)) === set)
    const available = files.filter((entry) => entry.file.status === 'AVAILABLE')
    let payProblem: string | null = null
    for (const entry of available) payProblem ??= await payProblemOf(client, { recordType: 'StoredFile', recordId: entry.fileId })
    const party = await client.party.findUnique({ where: { id: link.partyId }, select: { language: true } })
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    return { files, available, onFile, siblings, payProblem, party, company }
  })
  const refusal = fileRenewalRefusal({
    purpose: link.purpose,
    recordType: link.recordType,
    state: linkState(link, now),
    email: link.email,
    addressOnFile: facts.onFile.length > 0,
    files: facts.files.length,
    filesAvailable: facts.available.length,
    liveSibling: facts.siblings.some((row) => linkState(row, now) === 'LIVE'),
    askedRecently: facts.siblings.some((row) => row.renewalOfId === link.id && row.createdAt.getTime() > now.getTime() - LINK_RENEW_COALESCE_MS),
    payProblem: facts.payProblem,
  })
  if (refusal) return refusal

  const to = normal(link.email!)
  const newLinkId = newId()
  const token = mintLinkToken({ tenantId: (system.factoryContext as { tenantId: string }).tenantId, partyId: link.partyId, linkId: newLinkId })
  const locale = localeOf(facts.onFile[0]?.language ?? facts.party?.language)
  const companyName = facts.company ? (facts.company.tradeName ?? facts.company.legalName) : ''
  const names = facts.available.map((entry) => entry.file.originalName)
  const secure = link.purpose === 'SECURE_FILE'

  let queued: { outboundId: string; expiresAt: string; maxUses: number }
  try {
    const { result } = await linkCommand(system, { name: 'links.renew', input: { renewalOf: link.id } }, async (tools) => {
      const { tx } = tools
      // Again under the transaction: a second request (or the office) may have sent one meanwhile.
      const live = await tx.oneOffLink.findMany({ where: { recordType: link.recordType, recordId: link.recordId, purpose: link.purpose, email: to, revokedAt: null, id: { not: link.id } }, select: { expiresAt: true, revokedAt: true, uses: true, maxUses: true, renewalOfId: true, files: { select: { fileId: true } } } })
      const set = sameSet(facts.files.map((entry) => entry.fileId))
      if (live.some((row) => linkState(row, tools.now) === 'LIVE' && (row.renewalOfId === link.id || sameSet(row.files.map((entry) => entry.fileId)) === set))) throw new InvalidStateError('A live link of these files went to that address already.')
      const stillThere = await tx.storedFile.findMany({ where: { id: { in: facts.available.map((entry) => entry.fileId) }, status: 'AVAILABLE' }, select: { id: true } })
      const ids = facts.available.map((entry) => entry.fileId).filter((fileId) => stillThere.some((row) => row.id === fileId))
      if (ids.length === 0) throw new InvalidStateError('None of its files is available any more.')
      const terms = renewalTerms(link.purpose, link, tools.now)
      await tx.oneOffLink.createMany({
        data: [
          {
            id: newLinkId,
            companyId: link.companyId,
            partyId: link.partyId,
            purpose: link.purpose,
            recordType: link.recordType,
            recordId: link.recordId,
            tokenHash: linkTokenHash(token.value),
            email: to,
            note: link.note,
            expiresAt: terms.expiresAt,
            maxUses: terms.maxUses,
            passwordHash: link.passwordHash,
            contactId: link.contactId,
            renewalOfId: link.id,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: SYSTEM_ACTOR_ID,
          },
        ],
      })
      await tx.linkFile.createMany({ data: ids.map((fileId, index) => ({ id: newId(), partyId: link.partyId, linkId: newLinkId, fileId, position: index + 1, createdAt: tools.now })) })
      tools.audit({
        action: 'links.renew',
        recordType: 'OneOffLink',
        recordId: newLinkId,
        companyId: link.companyId,
        after: { renewalOf: link.id, purpose: link.purpose, recordType: link.recordType, recordId: link.recordId, partyId: link.partyId, email: to, files: ids, password: link.passwordHash !== null, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses },
      })
      tools.emit({ type: 'link.renewed', subject: newLinkId, companyId: link.companyId, payload: { linkId: newLinkId, renewalOfId: link.id, purpose: link.purpose, recordType: link.recordType, recordId: link.recordId } })
      const mail = linkFilesMail({ locale, companyName, secure, fileNames: names, expiresAt: terms.expiresAt, uses: terms.maxUses, password: link.passwordHash !== null, renewal: true, message: null }, '')
      const outboundId = await queueLinkMail(tools, { companyId: link.companyId, linkId: newLinkId, to, locale, subject: mail.subject, template: LINK_MAIL_TEMPLATES.renewed, sender: null })
      return { outboundId, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses }
    })
    queued = result
  } catch (error) {
    system.log.info({ kind: (error as Error).name }, 'a link renewal lost to a newer change')
    return 'CHANGED'
  }
  const text = linkFilesMail({ locale, companyName, secure, fileNames: names, expiresAt: new Date(queued.expiresAt), uses: queued.maxUses, password: link.passwordHash !== null, renewal: true, message: null }, auth.link('/l', token.value)).body
  const outcome = await deliverLinkMail(email, system, queued.outboundId, text, null, auth.clock)
  return outcome === 'SENT' ? 'SENT' : 'MAIL_FAILED'
}

/** The dead link's token the page sends (the same header every link page uses). */
export const renewTokenOf = (request: FastifyRequest): unknown => request.headers[LINK_HEADER]

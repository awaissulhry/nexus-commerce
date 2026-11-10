import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { formatPublicDocCode, publicDocAddress, publicDocCodeHex, publicDocCodeOf, publicDocPath, readPublicDocCode, type PublicDocKind } from '@nexus/factory-domain/compliance/public-doc/code'
import type { AddressView, LookupBody, PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { MAX_CODE_MATCHES } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { pickPage, publicDocPage, servedFileIds } from '@nexus/factory-domain/compliance/public-doc/rules'
import { DomainError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DOCUMENT_CONTENT_TYPE } from '@nexus/factory-domain/product/compliance/rules'
import { STYLE_COMPLIANCE_VIEW } from '@nexus/factory-domain/product/compliance/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { abuseGuardOf } from '../../../platform/abuse/guard'
import { asContext } from '../../../platform/branding/branding'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { KIND_RULES } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { systemContext } from '../../../platform/outbox/system'
import { readMatchFacts, type CodeMatch } from './facts'
// B-W2b-249: the sender follows the economic operators (Owner question 3: the brand for a style sold under its name).
import { readDocSender } from './sender'
// B-W2b-260 (RG1:01): a recall's or withdrawal's public notice of the batch or style, first on the page.
import { readPublicNotices } from './notice'

/**
 * The public DoC (B-W2b-166; PRD-294, PRD-356; design links.doc; Reg. (EU) 2016/425 art. 8(8), Reg. (EU) 2023/988 art. 19):
 * `/doc/<code>` on the factory web — the QR on the garment label and in the instructions, or the code typed when the QR is
 * damaged — opens the declaration valid for that batch (its frozen style revision) or the style's current one, the
 * certificate summary, the user information of the same revision and the older declarations, for anyone, with no sign-in.
 *
 * The code (factory-domain compliance/public-doc/code.ts) is the end of a record's id, so the tenant is not in it: the
 * platform scope lists the ACTIVE tenants (it reads only the Tenant table), then each tenant is read in its own SYSTEM
 * scope (row-level security stays forced) for a released work order (a batch number and a release day) or a style whose
 * id ends with the code's bits. EVERY active tenant is asked on every lookup (no early stop), so the time an answer takes
 * says nothing of where a code was found. A style counts only with a published declaration; a work order only once
 * released. Every miss — not a code, unknown, a draft work order, a style with nothing published, an inactive tenant —
 * is the same 404 in the same words, and raises the network's suspicion (the abuse guard, policy `public.lookup`).
 *
 * Reads only: nothing is written (no audit row: a reader holding the garment is nobody we know). The PDFs are streamed
 * through the API from the file store (one gateway read each, then kept in this process: a stored file never changes).
 */

let clock: Clock = serverClock
/** Tests set the day ("today" decides a style's certificate validity). */
export function usePublicDocClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
const today = (): BusinessDate => businessDate(clock.now())

/** The one answer for every miss (the page says its own words). */
export const NOT_FOUND_WORDS = 'We could not find this code. Check it on the label.'
const notFound = () => new NotFoundError(NOT_FOUND_WORDS)

/** A page found under a code, with the tenant it lives in. */
interface Found {
  readonly match: CodeMatch
  readonly page: PublicDocPage
}

const platformOf = (request: FastifyRequest) => asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId: String(request.id) })
const inTenant = <T>(request: FastifyRequest, tenantId: string, work: (client: FactoryClient) => Promise<T>) => asContext(request, systemContext(tenantId, String(request.id))).withClient(work)

/** The released work orders and the styles of one tenant whose id ends with the code's 40 bits (UUID text: the last 10 hex digits). */
async function idsEndingWith(client: FactoryClient, hex: string): Promise<{ kind: PublicDocKind; id: string }[]> {
  const batches = await client.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "WorkOrder" WHERE right(id::text, 10) = ${hex} AND "batchNumber" IS NOT NULL AND "releasedAt" IS NOT NULL`
  const styles = await client.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "Style" WHERE right(id::text, 10) = ${hex}`
  return [...batches.map((row) => ({ kind: 'BATCH' as const, id: row.id })), ...styles.map((row) => ({ kind: 'STYLE' as const, id: row.id }))]
}

/**
 * Every page under a code, oldest record first (ids are UUIDv7: a record made later never takes the place of one whose code
 * was printed before it). Empty for a miss. A style without a published declaration and a work order not released are
 * not pages.
 */
export async function pagesUnder(request: FastifyRequest, code: string): Promise<Found[]> {
  const hex = publicDocCodeHex(code)
  const tenants = await platformOf(request).withClient(async (client) => (await client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id))
  const day = today()
  const found: Found[] = []
  for (const tenantId of tenants) {
    const pages = await inTenant(request, tenantId, async (client) => {
      const own: Found[] = []
      for (const hit of await idsEndingWith(client, hex)) {
        const match: CodeMatch = { tenantId, ...hit }
        const read = await readMatchFacts(client, match, code, day)
        if (!read) continue
        const head = await readDocSender(client, match, read.companyId, day)
        if (!head) continue
        // B-W2b-260: `notices` (the recall notices of this batch or style).
        const page = publicDocPage({ ...read.facts, style: { ...read.facts.style, privateLabel: head.makerRole === 'BRAND' }, notices: await readPublicNotices(client, match) }, head.sender, head.contact)
        if (match.kind === 'STYLE' && page.declaration === null) continue
        own.push({ match, page })
      }
      return own
    })
    found.push(...pages)
  }
  return found.sort((a, b) => (a.match.id < b.match.id ? -1 : a.match.id > b.match.id ? 1 : 0)).slice(0, MAX_CODE_MATCHES)
}

/** POST /public/doc/lookup (anyone): the page of a code, or the one 404. */
export async function lookupPublicDoc(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: LookupBody): Promise<{ page: PublicDocPage }> {
  const guard = abuseGuardOf(app)
  // Per network only, never per code: one batch's code is scanned by every buyer of its garments, from anywhere. The
  // network's limit, and the challenge after many lookups or misses, stop anyone walking through codes.
  await guard.check(request, reply, 'public.lookup', { proof: body.proof })
  const code = readPublicDocCode(body.code)
  const page = code ? pickPage((await pagesUnder(request, code)).map((entry) => entry.page), body.n ?? 0) : null
  if (!page) {
    await guard.failed(request, 'public.lookup')
    throw notFound()
  }
  return { page }
}

// ---- the PDFs ---------------------------------------------------------------------------------------------------------------

export interface PublicDocPdf {
  readonly bytes: Buffer
  readonly name: string
}

/** The bytes kept per tenant and file (a stored file's content never changes), newest use last, at most this much. */
const CACHE_BYTES = 48 * 1024 * 1024
const cache = new Map<string, Buffer>()
let cachedBytes = 0

function remember(key: string, bytes: Buffer): Buffer {
  const before = cache.get(key)
  if (before) {
    cache.delete(key)
    cachedBytes -= before.length
  }
  if (bytes.length > CACHE_BYTES / 4) return bytes
  cache.set(key, bytes)
  cachedBytes += bytes.length
  while (cachedBytes > CACHE_BYTES) {
    const [oldest, value] = cache.entries().next().value as [string, Buffer]
    cache.delete(oldest)
    cachedBytes -= value.length
  }
  return bytes
}

/** Forget every kept PDF (tests). */
export function forgetPublicDocFiles(): void {
  cache.clear()
  cachedBytes = 0
}

/**
 * GET /public/doc/:code/files/:fileId (anyone): one of the page's PDFs — the declaration or the leaflet of a language, of
 * this revision or an older one — and nothing else: a file the page does not list is the same 404 as an unknown code.
 */
export async function publicDocFile(app: FastifyInstance, request: FastifyRequest, codeParam: string, fileId: string): Promise<PublicDocPdf> {
  const guard = abuseGuardOf(app)
  const code = readPublicDocCode(codeParam)
  const owner = code && isUuid(fileId) ? (await pagesUnder(request, code)).find((entry) => servedFileIds(entry.page).has(fileId)) : undefined
  if (!owner) {
    await guard.failed(request, 'public.lookup')
    throw notFound()
  }
  const system = systemCallerOf(request)(owner.match.tenantId)
  const row = await system.withClient((client) =>
    client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, status: true, recordType: true, contentType: true, originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true } }),
  )
  if (!row || row.status !== 'AVAILABLE' || row.recordType !== 'ComplianceDocument' || row.contentType !== DOCUMENT_CONTENT_TYPE) throw notFound()
  const key = `${owner.match.tenantId}:${row.id}`
  const kept = cache.get(key)
  if (kept) return { bytes: remember(key, kept), name: row.originalName }
  const bytes = await processFiles().storage.read(system, row.storeAccountId, row.storageKey, KIND_RULES.DOCUMENT.maxBytes)
  if (!bytes) throw new DomainError('not_ready', 'The file store did not answer. Try again in a moment.')
  return { bytes: remember(key, bytes), name: row.originalName }
}

// ---- the office: the address a label prints -------------------------------------------------------------------------------

/**
 * GET /compliance/public-doc/address?styleId= | ?workOrderId= (office, compliance.certificates.view over the record's
 * company): the code and the whole address the QR holds, and whether the page shows something today (a released batch; a
 * style with a published declaration). The label builder and the declarations' publication read it; the code itself is
 * pure (factory-domain publicDocCodeOf), so a printed QR never waits for this.
 */
export async function officeAddress(caller: CommandCaller, query: { readonly styleId?: string | undefined; readonly workOrderId?: string | undefined }): Promise<{ address: AddressView }> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if ((query.styleId === undefined) === (query.workOrderId === undefined)) {
    throw new ValidationError('Name one record.', [{ path: 'querystring', message: 'Give styleId or workOrderId, not both.' }])
  }
  const actor = actorOf(context)
  const view = await caller.withClient(async (client): Promise<AddressView> => {
    if (query.workOrderId !== undefined) {
      const order = await client.workOrder.findUnique({ where: { id: query.workOrderId }, select: { id: true, companyId: true, batchNumber: true, releasedAt: true } })
      if (!order || !can(actor, STYLE_COMPLIANCE_VIEW, { companyId: order.companyId })) throw new NotFoundError('Work order not found.')
      return addressViewOf('BATCH', order.id, order.batchNumber !== null && order.releasedAt !== null)
    }
    const style = await client.style.findUnique({ where: { id: query.styleId! }, select: { id: true, companyId: true } })
    if (!style || !can(actor, STYLE_COMPLIANCE_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
    const code = publicDocCodeOf(style.id)
    const read = await readMatchFacts(client, { tenantId: 'office', kind: 'STYLE', id: style.id }, code, today())
    const live = read !== null && publicDocPage(read.facts, PLACEHOLDER_SENDER, { email: null }).declaration !== null
    return addressViewOf('STYLE', style.id, live)
  })
  return { address: view }
}

/** The page's own sender is not needed to know whether it shows a declaration. */
const PLACEHOLDER_SENDER: PublicDocPage['sender'] = { companyId: '00000000-0000-7000-8000-000000000000', name: '', companyName: '', logoPath: null, logoDarkPath: null, accentColour: null }

function addressViewOf(kind: PublicDocKind, id: string, live: boolean): AddressView {
  const code = publicDocCodeOf(id)
  return { kind, code: formatPublicDocCode(code), path: publicDocPath(code), address: publicDocAddress(processEmail().webOrigin, code), live }
}

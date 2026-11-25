import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { CreateStyleBody } from '@nexus/factory-domain/product/styles/contracts'
import type { StyleDraftBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { STYLE_DRAFTS_MAX } from '@nexus/factory-domain/sales/inquiries/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { STYLE_DRAFT_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { StaleVersionError } from '../../../core/command'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { codeConflict, makeStyleInCommand, prepareStyle } from '../../product/styles/styles'
import { isUniqueViolation } from '../../product/styles/store'
import { carryFiles } from '../inquiries/carry'
import { draftChanged } from './requests'
import { draftFilesWhere, readLines, readRequest, type RequestRow } from './store'
import { officeDraftWriter } from './writer'

/**
 * od-s s.3 (order start, 13-backend § 4; L5; Owner yes 4a): "Make style draft" on a customer's draft order — the design starts while
 * details are still open. A copy of the Inquiry's (modules/sales/inquiries/style-draft.ts):
 *
 *   POST /sales/order-requests/:requestId/style-draft   orders.view over the draft's company and customer (out of reach: 404), and
 *                                                       product.styles.manage over its company (the style library's own check,
 *                                                       refused in words: Sales does not hold it, the Production manager does)
 *
 * In ONE command: the request locked at the version read, DRAFT or SENT (a decided request takes none: 409 in words), the style made
 * by the style library's own making (`makeStyleInCommand`: DRAFT, its code free, `style.created`) with the request's company and, as
 * its brand, the REQUEST's customer — never one the body names (W12: the body has no brand field) — its name the draft's subject
 * unless typed; the style appended to the request's `styleIds` (office only: the partner role cannot read it; at most 50, each once;
 * the database rechecks that no other customer's own label is named), the version moved, the audit row and draft_changed (the
 * customer's open draft reads again: "The factory is working on the design."; it sees the style itself on its Samples page). The
 * draft's own logos and references picked are then carried to the style (Use on…; a measurement sheet never: body data).
 */

/** The draft's files the office may carry to a style: its own and its lines', AVAILABLE, never a measurement sheet. */
async function draftFilesOf(request: FastifyRequest, row: RequestRow, picked: readonly string[]) {
  if (picked.length === 0) return []
  const lineIds = (await request.withClient((client) => readLines(client, [row.id]))).map((line) => line.id)
  const files = await request.withClient((client) =>
    client.storedFile.findMany({ where: { AND: [draftFilesWhere([row.id], lineIds), { partyId: row.partyId, status: 'AVAILABLE', NOT: { category: 'MEASUREMENTS' } }] }, select: { id: true, originalName: true, visibility: true } }),
  )
  return picked.flatMap((fileId) => files.filter((file) => file.id === fileId)).map((file) => ({ id: file.id, originalName: file.originalName ?? '', visibility: [...file.visibility] as string[] }))
}

const refused = (code: keyof typeof STYLE_DRAFT_WORDS, words: string): DomainError => new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])

/** POST /sales/order-requests/:requestId/style-draft: "Make style draft". */
export async function styleDraftOfRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, body: StyleDraftBody, idempotencyKey?: string) {
  const { row } = await officeDraftWriter(app, request, requestId, ORDERS_VIEW)
  if (row.status !== 'DRAFT' && row.status !== 'SENT') throw refused('CLOSED', STYLE_DRAFT_WORDS.CLOSED.en)
  const styleIds = (await request.withClient((client) => client.portalOrderRequest.findUniqueOrThrow({ where: { id: row.id }, select: { styleIds: true } }))).styleIds
  if (styleIds.length >= STYLE_DRAFTS_MAX) throw refused('STYLE_DRAFTS_FULL', STYLE_DRAFT_WORDS.STYLE_DRAFTS_FULL.en)
  const picked = body.fileIds ?? []
  const files = await draftFilesOf(request, row, picked)
  const missing = picked.filter((fileId) => !files.some((file) => file.id === fileId))
  if (missing.length > 0) throw new ValidationError('Pick logos or references of this draft that are available.', missing.map((fileId) => ({ path: `body/fileIds/${picked.indexOf(fileId)}`, message: 'Not an available logo or reference of this draft.' })))
  const named = row.subject ?? row.number ?? 'Draft order'
  const styleBody: CreateStyleBody = {
    companyId: row.companyId,
    code: body.code,
    name: body.name ?? named.slice(0, 200),
    productType: body.productType,
    brandPartyId: row.partyId,
    ...(body.productTypeProfileId !== undefined ? { productTypeProfileId: body.productTypeProfileId } : {}),
    ...(body.sizeScaleId !== undefined ? { sizeScaleId: body.sizeScaleId } : {}),
    ...(body.sizes !== undefined ? { sizes: body.sizes } : {}),
    ...(body.baseSize !== undefined ? { baseSize: body.baseSize } : {}),
    ...(body.season !== undefined ? { season: body.season } : {}),
    ...(body.ppeCategory !== undefined ? { ppeCategory: body.ppeCategory } : {}),
  } as CreateStyleBody
  // product.styles.manage over the company, the type's defaults and the range: refused in words before any lock.
  const prepared = await prepareStyle(request, styleBody)

  const { result } = await commandOn(app, request, { name: 'portalOrdering.styleDraft', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT "id" FROM "PortalOrderRequest" WHERE "id" = ${row.id}::uuid FOR UPDATE`
    const current = await readRequest(tools.tx, row.id)
    if (!current || current.partyId !== row.partyId) throw refused('CLOSED', STYLE_DRAFT_WORDS.CLOSED.en)
    if (current.version !== body.version) throw new StaleVersionError('PortalOrderRequest', current.id, current.version, body.version)
    if (current.status !== 'DRAFT' && current.status !== 'SENT') throw refused('CLOSED', STYLE_DRAFT_WORDS.CLOSED.en)
    const before = (await tools.tx.portalOrderRequest.findUniqueOrThrow({ where: { id: current.id }, select: { styleIds: true } })).styleIds
    if (before.length >= STYLE_DRAFTS_MAX) throw refused('STYLE_DRAFTS_FULL', STYLE_DRAFT_WORDS.STYLE_DRAFTS_FULL.en)
    const style = await makeStyleInCommand(tools, styleBody, prepared)
    const after = [...before, style.id]
    const { count } = await tools.tx.portalOrderRequest.updateMany({ where: { id: current.id, version: current.version }, data: { styleIds: after, version: current.version + 1, updatedAt: tools.now } })
    if (count === 0) throw new StaleVersionError('PortalOrderRequest', current.id, current.version + 1, current.version)
    tools.audit({ action: 'portalOrdering.styleDraft', recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { styleIds: before }, after: { styleIds: after, styleId: style.id, styleCode: style.code } })
    draftChanged(tools, current)
    return { styleId: style.id, code: style.code, name: style.name, status: style.status, version: current.version + 1 }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(prepared.code)
    throw error
  })
  return { ...result, files: await carryFiles(request, files, { recordType: 'Style', recordId: result.styleId }, idempotencyKey) }
}

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { isCustomer } from '@nexus/factory-domain/parties/rules'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { RequestSource } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { mayOn, officeContextOf } from '../orders/access'
import { announceDraftFile, completeDraftFile, discardDraftWithFiles, moveDraftFile, removeDraftFile, type DraftFileBody } from './draft-files'
import { addCustomLine, addPeople, changeCustomLine, changeHeader, changeLine, changePerson, createDraft, removePerson, requestView, type HeaderBody } from './requests'
import { copyLine, putBackLine, removeLine } from './requests' // owb- po1.3
import { officeDraftWriter, officeWriter, refuseOwnPrice, type DraftWriter } from './writer'

/**
 * od-s s.3 (order start, 13-backend § 4; Owner yes 1a + 2a): the office's door to a customer's draft order — the SAME draft commands
 * as the portal (./requests.ts, ./draft-files.ts) through the office writer (./writer.ts). Office sessions; each route checks
 * orders.manage (orders.view to read) over the draft's company AND its customer first: a draft out of reach is "Order request not
 * found." (404), as a wrong id. No Incoming row (Owner yes 3a): the office finds a draft on the customer page and in its thread.
 *
 *   POST   /sales/order-requests                                   a new draft for a customer: {companyId, partyId, subject?, note?, …header}
 *   GET    /sales/order-requests/:id/draft                         the draft as the portal reads it (the same record), grain-filtered
 *   PATCH  /sales/order-requests/:id                               its header (subject, their PO, ship-to, date, the customer's message)
 *   DELETE /sales/order-requests/:id?version=                      discarded — only a draft an office person started
 *   POST   /sales/order-requests/:id/custom-lines                  a product row (described or made to measure; its sizing, choices)
 *   PUT    /sales/order-requests/:id/custom-lines/:lineId          a product row changed
 *   PUT    /sales/order-requests/:id/lines/:lineId                 a catalogue row's sizes, colour, note, sizing, choices
 *   DELETE /sales/order-requests/:id/lines/:lineId?version=        a row taken out (owb- po1.3: soft — its people and files stay)
 *   POST   /sales/order-requests/:id/lines/:lineId/copy            owb- po1.3: a row copied whole at the end (never its people or files)
 *   POST   /sales/order-requests/:id/lines/:lineId/put-back        owb- po1.3: a row taken out comes back as it was
 *   POST   /sales/order-requests/:id/lines/:lineId/people          people of a by-person row (naming a sheet: sales.measurements.view)
 *   PUT    /sales/order-requests/:id/lines/:lineId/people/:personId
 *   DELETE /sales/order-requests/:id/lines/:lineId/people/:personId?version=
 *   POST   /sales/order-requests/:id/files                         a file announced (files.upload; the outside-upload gate as ever)
 *   POST   /sales/order-requests/:id/files/:fileId/complete
 *   DELETE /sales/order-requests/:id/files/:fileId?version=
 *   PATCH  /sales/order-requests/:id/files/:fileId                  {version, part}: a file moved between logos and references (od-ts t.6)
 *
 * Money wall: the office never types the customer's own price (`brandUnitPrice`, 400 in words); the office stamps the list price
 * on a catalogue row (W4), which the grain filter keeps out of a no-price answer. Not this round (they read the portal session):
 * office Pick styles, Reorder and Upload into a draft.
 */

/** The office's writer of a draft, `permission` over its company and customer (404 out of reach, 403 without it). */
const writerOf = async (app: FastifyInstance, request: FastifyRequest, requestId: string, permission: Permission = ORDERS_MANAGE): Promise<DraftWriter> => (await officeDraftWriter(app, request, requestId, permission)).writer

export interface OfficeStartBody extends HeaderBody {
  readonly companyId: string
  readonly partyId: string
  readonly source?: RequestSource | undefined
}

/** POST /sales/order-requests: the office starts a customer's draft (in the office page's company); nothing else is needed. */
export async function officeStartDraft(app: FastifyInstance, request: FastifyRequest, body: OfficeStartBody, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const { companyId, partyId, ...header } = body
  const company = isUuid(companyId) ? await request.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  const party = isUuid(partyId) ? await request.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, roles: true } })) : null
  if (!party || (party.companyId !== null && party.companyId !== companyId)) throw new NotFoundError('Customer not found.')
  // can() first: a customer out of reach is not found (the brand wall), as a wrong id; in reach without orders.manage: 403.
  if (!mayOn(context, ORDERS_VIEW, { companyId, partyId })) throw new NotFoundError('Customer not found.')
  const writer = officeWriter(app, request, { companyId, partyId }, ORDERS_MANAGE)
  if (!isCustomer(party.roles)) throw new InvalidStateError('Give the party the customer (or brand) role first.')
  return createDraft(writer, header, idempotencyKey)
}

/** GET /sales/order-requests/:id/draft: the draft as the portal reads it — the same record — for orders.view over its customer. */
export async function officeDraftView(app: FastifyInstance, request: FastifyRequest, requestId: string) {
  const { writer, row } = await officeDraftWriter(app, request, requestId, ORDERS_VIEW)
  return requestView(writer, row)
}

export async function officeChangeHeader(app: FastifyInstance, request: FastifyRequest, requestId: string, body: HeaderBody & { readonly version: number }, idempotencyKey?: string) {
  return changeHeader(await writerOf(app, request, requestId), requestId, body, idempotencyKey)
}

export async function officeDiscard(files: () => FilesRuntime, app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  return discardDraftWithFiles(files, await writerOf(app, request, requestId), requestId, version, idempotencyKey)
}

export async function officeAddCustomLine(app: FastifyInstance, request: FastifyRequest, requestId: string, body: Parameters<typeof addCustomLine>[2], idempotencyKey?: string) {
  const writer = await writerOf(app, request, requestId)
  refuseOwnPrice(body, 'body')
  return addCustomLine(writer, requestId, body, idempotencyKey)
}

export async function officeChangeCustomLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, body: Parameters<typeof changeCustomLine>[3], idempotencyKey?: string) {
  const writer = await writerOf(app, request, requestId)
  refuseOwnPrice(body, 'body')
  return changeCustomLine(writer, requestId, lineId, body, idempotencyKey)
}

export async function officeChangeLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, body: Parameters<typeof changeLine>[3], idempotencyKey?: string) {
  const writer = await writerOf(app, request, requestId)
  refuseOwnPrice(body, 'body')
  return changeLine(writer, requestId, lineId, body, idempotencyKey)
}

/** owb- po1.3: "Take out" is a soft remove (the row's people and files stay for "Put it back"). */
export async function officeRemoveLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  return removeLine(await writerOf(app, request, requestId), requestId, lineId, version, idempotencyKey)
}

/** owb- po1.3: a row copied (the customer's own price never: the office does not type it). */
export async function officeCopyLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  return copyLine(await writerOf(app, request, requestId), requestId, lineId, version, idempotencyKey)
}

/** owb- po1.3: a row taken out put back. */
export async function officePutBackLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  return putBackLine(await writerOf(app, request, requestId), requestId, lineId, version, idempotencyKey)
}

export async function officeAddPeople(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, body: Parameters<typeof addPeople>[3], idempotencyKey?: string) {
  return addPeople(await writerOf(app, request, requestId), requestId, lineId, body, idempotencyKey)
}

export async function officeChangePerson(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, personId: string, body: Parameters<typeof changePerson>[4], idempotencyKey?: string) {
  return changePerson(await writerOf(app, request, requestId), requestId, lineId, personId, body, idempotencyKey)
}

export async function officeRemovePerson(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, personId: string, version: number, idempotencyKey?: string) {
  return removePerson(await writerOf(app, request, requestId), requestId, lineId, personId, version, idempotencyKey)
}

export async function officeAnnounceFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, requestId: string, body: DraftFileBody, idempotencyKey?: string) {
  return announceDraftFile(files, await writerOf(app, request, requestId), requestId, body, idempotencyKey)
}

export async function officeCompleteFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, requestId: string, fileId: string, idempotencyKey?: string) {
  return completeDraftFile(files, await writerOf(app, request, requestId), requestId, fileId, idempotencyKey)
}

/** od-ts t.6: PATCH /sales/order-requests/:id/files/:fileId {version, part} — the "Logo" toggle (orders.manage + files.upload). */
export async function officeMoveFile(app: FastifyInstance, request: FastifyRequest, requestId: string, fileId: string, body: Parameters<typeof moveDraftFile>[3], idempotencyKey?: string) {
  return moveDraftFile(await writerOf(app, request, requestId), requestId, fileId, body, idempotencyKey)
}

export async function officeRemoveFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, requestId: string, fileId: string, version: number, idempotencyKey?: string) {
  return removeDraftFile(files, await writerOf(app, request, requestId), requestId, fileId, version, idempotencyKey)
}

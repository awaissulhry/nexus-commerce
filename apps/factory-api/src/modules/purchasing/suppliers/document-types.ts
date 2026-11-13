import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { eventFor } from '@nexus/factory-domain/events/define'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { isVaultCategory, VAULT_CATEGORIES, type VaultCategory } from '@nexus/factory-domain/purchasing/qualification/vault'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { z } from 'zod'
import { events as followupEvents } from '@nexus/factory-domain/buying-followups/events'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { activeReasonCodes } from '../../../platform/reasons/service'
import { officeContextOf } from '../store'

/**
 * What a supplier's document is (B-W2b-377; follow-up XF5:06; SCM-020; B-W2b-315's vault and PO gate, B-W2b-363's
 * StoredFile.documentTypeCode and reason list SUPPLIER_DOCUMENT_TYPE). A vault file (a CURRENT file of the supplier's Party
 * tagged SUPPLIER_CERTIFICATE, TEST_REPORT or DECLARATION) carries an active code of the tenant's SUPPLIER_DOCUMENT_TYPE list
 * (`GET /reasons?list=SUPPLIER_DOCUMENT_TYPE`: DURC, LWG_AUDIT, ISO_9001, CR_VI_TEST_REPORT …, the vault's ASKED_BY_KIND codes).
 *
 *   matching  an ask (factory-domain vault ASKED_BY_KIND: the codes of a category) is met by a document of its category whose
 *             type is one of the ask's codes (an LWG audit ask also by an ISO 9001 certificate: "an LWG audit or an ISO 9001 /
 *             14001 certificate"); a document with NO type still meets any ask of its category, as before this step (a file
 *             tagged before it, untyped, keeps holding until someone types it). A typed document of another code does not:
 *             a DURC is never taken for an ISO certificate, an azo-dye test report never for the chromium VI one.
 *   the gate  the chromium VI test report a tannery's leather needs (qualification/store.ts gateFactsOf) is a TEST_REPORT typed
 *             CR_VI_TEST_REPORT, or untyped
 *   the type  PUT /purchasing/suppliers/:partyId/documents/:fileId/type {version, documentTypeCode | null} (files.upload over
 *             the file's company and parties.view over the supplier): ONE command on the StoredFile at the version read; the
 *             database checks the code is the list's and the file a vault category (B-W2b-363's StoredFile_w2b6_change)
 */

const [, , , typedEvent] = followupEvents

/** The other codes that meet an ask's code (the ask's own words say "an LWG audit or an ISO 9001 / 14001 certificate"). */
const ALSO_MEETS: Readonly<Record<string, readonly string[]>> = Object.freeze({ LWG_AUDIT: ['ISO_9001'] })

/** Whether a document meets an ask of these codes: untyped (its category is all it says), or typed one of them. */
export function meetsAsk(doc: { readonly documentTypeCode: string | null }, codes: readonly string[]): boolean {
  if (doc.documentTypeCode === null) return true
  return codes.some((code) => code === doc.documentTypeCode || (ALSO_MEETS[code] ?? []).includes(doc.documentTypeCode!))
}

/** The documents that may meet an ask of these codes (the vault's asks, the gate's chromium VI test report). */
export const documentsFor = <Doc extends { readonly documentTypeCode: string | null }>(documents: readonly Doc[], codes: readonly string[]): Doc[] => documents.filter((doc) => meetsAsk(doc, codes))

export interface TypeBody {
  readonly version: number
  readonly documentTypeCode: string | null
}

/** PUT /purchasing/suppliers/:partyId/documents/:fileId/type. */
export async function setDocumentType(caller: CommandCaller, partyId: string, fileId: string, body: TypeBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const file = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, recordType: true, recordId: true, companyId: true, category: true, status: true, supersededAt: true, documentTypeCode: true } }))
  const party = file ? await caller.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true } })) : null
  if (!file || !party || file.recordType !== 'Party' || file.recordId !== partyId || !can(actor, PARTIES_VIEW, { companyId: party.companyId, partyId })) throw new NotFoundError('Document not found.')
  if (!can(actor, FILES_UPLOAD, { companyId: file.companyId })) throw new DomainError('forbidden', "Saying what a supplier's document is needs files.upload over its company.")
  if (!isVaultCategory(file.category)) throw new ConflictError('Only a certificate, a test report or a declaration of the supplier says what document it is: tag its kind first.')
  if (file.status !== 'AVAILABLE' || file.supersededAt !== null) throw new ConflictError('Only the current version of a document says what it is: an earlier version is read-only.')
  const code = body.documentTypeCode === null ? null : body.documentTypeCode.trim().toUpperCase()
  const { result } = await command(caller, { name: 'purchasing.setDocumentType', idempotencyKey, input: { partyId, fileId, ...body }, record: { type: 'StoredFile', id: fileId, expectedVersion: body.version } }, async (tools) => {
    if (code !== null && !(await activeReasonCodes(tools.tx, 'SUPPLIER_DOCUMENT_TYPE')).has(code)) {
      throw new ValidationError('Choose a document type of the list (Admin › Reason lists › Supplier document types).', [{ path: 'body/documentTypeCode', message: 'Not an active supplier document type.' }])
    }
    const before = (await tools.tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { documentTypeCode: true, category: true } }))
    if (before.documentTypeCode === code) return { fileId, documentTypeCode: code, category: before.category as VaultCategory, unchanged: true }
    await tools.tx.storedFile.update({ where: { id: fileId }, data: { documentTypeCode: code, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.setDocumentType', recordType: 'StoredFile', recordId: fileId, companyId: file.companyId, before: { documentTypeCode: before.documentTypeCode }, after: { documentTypeCode: code, partyId } })
    tools.emit(eventFor(typedEvent, { subject: fileId, companyId: file.companyId, payload: { fileId, partyId, documentTypeCode: code } }))
    return { fileId, documentTypeCode: code, category: before.category as VaultCategory, unchanged: false }
  })
  const version = await caller.withClient((client) => client.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { version: true } }))
  return { fileId: result.fileId, documentTypeCode: result.documentTypeCode, category: result.category, version: version.version }
}

// ---- the contract --------------------------------------------------------------------------------------------------------

export const documentTypeContract = defineContract({
  params: input({ partyId: id(), fileId: id() }),
  body: input({ version: z.number().int().min(1), documentTypeCode: z.string().trim().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/).nullable() }),
  response: { 200: output({ fileId: id(), documentTypeCode: z.string().nullable(), category: z.enum(VAULT_CATEGORIES), version: z.number().int() }) },
})

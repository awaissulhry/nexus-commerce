import { DomainError } from '@nexus/factory-domain/core/errors'
import type { AcceptAs, AcceptLineMapEntry } from '@nexus/factory-domain/sales/portal-ordering/office'
import { command, type CommandCaller } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { prepareFileCopy, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FileAudience } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'

/**
 * B-CP-077 (customer page plan C5, 12 §9 B-CP-062: "ARTWORK onto the order lines"): the customer's logos on its request carried to
 * what the accept made from it, AFTER the accept's command (as B-TH-025 carries an inquiry's files: the order stands even when a
 * file cannot be copied, and the answer says which and why). The draft's files of part LOGO are StoredFile category ARTWORK, on the
 * draft or on one of its lines (B-CP-072):
 *
 *   on a line     copied onto every order line (quote line) made from that request line, by the accept's line map — where the
 *                 line's artwork lives for the office, production and the portal (modules/sales/configurator artworkOf); a quote
 *                 line's artwork travels on to the order made from the quote without another copy
 *   on the draft  copied onto the order (quote) itself, beside its own files (the order's file set, production's order files)
 *
 * Each copy is the files platform's (prepareFileCopy: the bytes read from the store and checked against their SHA-256, put under a
 * new key, outside any transaction; then one command records every copy, recordGeneratedFile, each NAMING ITS SOURCE), category
 * ARTWORK kept, shared as the original was (the office, and the customer's own portal when the original was: its own logo, its own
 * order — never the floor or a link from here). A logo already carried to that record (a retried accept) is not copied again; one
 * not uploaded yet, or still checked, stays on the request and is named. Measurement sheets and references stay on the request
 * (body data and the customer's pictures are read there).
 */

export interface CarriedArtwork {
  readonly carried: { readonly sourceFileId: string; readonly fileId: string; readonly name: string; readonly recordType: string; readonly recordId: string }[]
  readonly notCarried: { readonly sourceFileId: string; readonly name: string; readonly reason: string }[]
}

const SHARED: readonly FileAudience[] = ['OFFICE', 'PARTNER']
const NOT_READY = 'This logo is still being uploaded or checked: it stays on the request (carry it with Use on… once it is there).'

interface Made {
  readonly as: AcceptAs
  readonly salesOrderId: string | null
  readonly quoteId: string | null
  readonly lines: readonly AcceptLineMapEntry[]
}

/** The logos of the request (its own and its lines'), carried to the order or quote it became (see the module's head). `files`: the store, asked only when a logo is copied. */
export async function carryArtwork(files: () => FilesRuntime, caller: CommandCaller, request: { readonly id: string; readonly companyId: string; readonly partyId: string; readonly number: string | null }, made: Made): Promise<CarriedArtwork> {
  const out: { carried: CarriedArtwork['carried'][number][]; notCarried: CarriedArtwork['notCarried'][number][] } = { carried: [], notCarried: [] }
  const own = made.as === 'ORDER' ? (made.salesOrderId ? { recordType: 'SalesOrder', recordId: made.salesOrderId } : null) : made.quoteId ? { recordType: 'Quote', recordId: made.quoteId } : null
  if (!own) return out
  const lineType = made.as === 'ORDER' ? 'SalesOrderLine' : 'QuoteLine'
  const intoOf = new Map(made.lines.map((entry) => [entry.requestLineId, entry.into]))
  const requestLineIds = made.lines.map((entry) => entry.requestLineId)
  const logos = await caller.withClient((client) =>
    client.storedFile.findMany({
      where: { category: 'ARTWORK', status: { not: 'DELETED' }, supersededAt: null, OR: [{ recordType: 'PortalOrderRequest', recordId: request.id }, ...(requestLineIds.length > 0 ? [{ recordType: 'PortalOrderRequestLine', recordId: { in: requestLineIds } }] : [])] },
      select: { id: true, recordType: true, recordId: true, originalName: true, status: true, visibility: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  if (logos.length === 0) return out
  const targetsOf = (logo: (typeof logos)[number]) => (logo.recordType === 'PortalOrderRequest' ? [own] : (intoOf.get(logo.recordId) ?? []).map((line) => ({ recordType: lineType, recordId: line.lineId })))
  const already = new Set(
    (await caller.withClient((client) => client.storedFile.findMany({ where: { sourceFileId: { in: logos.map((logo) => logo.id) }, status: { not: 'DELETED' } }, select: { sourceFileId: true, recordType: true, recordId: true } }))).map(
      (row) => `${row.sourceFileId}|${row.recordType}|${row.recordId}`,
    ),
  )
  const prepared: { readonly logo: (typeof logos)[number]; readonly file: PreparedGeneratedFile & { readonly sourceFileId: string } }[] = []
  for (const logo of logos) {
    if (logo.status !== 'AVAILABLE') {
      out.notCarried.push({ sourceFileId: logo.id, name: logo.originalName, reason: NOT_READY })
      continue
    }
    const visibility = SHARED.filter((audience) => logo.visibility.includes(audience))
    for (const target of targetsOf(logo)) {
      if (already.has(`${logo.id}|${target.recordType}|${target.recordId}`)) continue
      try {
        const file = await prepareFileCopy(files(), caller, logo.id, { companyId: request.companyId, recordType: target.recordType, recordId: target.recordId, visibility, partyId: visibility.includes('PARTNER') ? request.partyId : null })
        prepared.push({ logo, file })
      } catch (error) {
        // A refusal in words (the bytes missing, the store unavailable): said, the other logos carried on.
        if (!(error instanceof DomainError) && !(error instanceof ApiError)) throw error
        out.notCarried.push({ sourceFileId: logo.id, name: logo.originalName, reason: error.message })
      }
    }
  }
  if (prepared.length === 0) return out
  const { result } = await command(caller, { name: 'portalOrdering.carryArtwork', input: { requestId: request.id, files: prepared.map((entry) => `${entry.logo.id}>${entry.file.recordType}:${entry.file.recordId}`) } }, async (tools) => {
    const carried: CarriedArtwork['carried'][number][] = []
    for (const entry of prepared) {
      const copy = await recordGeneratedFile(tools, entry.file, { category: 'ARTWORK', details: { carriedFrom: 'PortalOrderRequest', requestId: request.id, requestNumber: request.number, sourceFileId: entry.logo.id } })
      carried.push({ sourceFileId: entry.logo.id, fileId: copy.id, name: entry.logo.originalName, recordType: entry.file.recordType, recordId: entry.file.recordId })
    }
    tools.audit({ recordType: 'PortalOrderRequest', recordId: request.id, companyId: request.companyId, after: { artworkCarried: carried.map((entry) => ({ sourceFileId: entry.sourceFileId, fileId: entry.fileId, recordType: entry.recordType, recordId: entry.recordId })) } })
    return carried
  })
  out.carried.push(...result)
  return out
}

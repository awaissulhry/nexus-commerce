import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUALITY_COMPLAINTS_LOG, QUALITY_COMPLAINTS_MANAGE } from '@nexus/factory-domain/quality/complaints/permissions'
import { COMPLAINT_RECORD, LINK_FIELDS, type ComplaintLinkType } from '@nexus/factory-domain/quality/complaints/rules'
import { QUALITY_NCR_MANAGE, QUALITY_NCR_RAISE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { NCR_LIMITS } from '@nexus/factory-domain/quality/ncr/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { emitChanged, lockNcrRow } from '../ncr/ncr'
import { NCR_RECORD } from '../ncr/store'
import { mayOn, officeComplaint } from './access'
import { recordOf } from './log'
import { changeComplaint } from './steps'
import { lockComplaint, touchComplaint, type ComplaintRow } from './store'

/**
 * Link… / Unlink on a complaint's Linked records (B-W2b-17; B-W2a-65's gap, design quality.complaints cmp-links "NCR,
 * CAPA, return, register entry, shipment, garment"). No link table: a link is one of the complaint's own facts or an NCR
 * that names the complaint.
 *
 *   SalesOrder · Shipment · ReturnAuthorisation   the complaint's order / shipment / return (changeComplaint: the same
 *                                                 checks as editing the facts — of the complaint's company and
 *                                                 customer —, its audit row and complaint.changed); one each: a second
 *                                                 is refused until the first is unlinked.
 *   GarmentSerial                                 the garment's serial as the complaint's serial (our garment found: its
 *                                                 style and batch are the record's garment facts).
 *   Nonconformance                                an NcrLink (recordType Complaint) on an open NCR of the complaint's
 *                                                 company, in ONE command that locks the complaint (its version moves
 *                                                 on) and the NCR (ncr.changed, fields links). Linking needs
 *                                                 quality.ncr.raise at the NCR's site, unlinking quality.ncr.manage; the
 *                                                 NCR raised from the complaint stays linked.
 *
 * Who: `log` while the complaint is NEW, `manage` once triaged (as for its facts). A closed complaint changes no more.
 */

export interface LinkBody {
  readonly version: number
  readonly recordType: ComplaintLinkType
  readonly recordId: string
}

const factOf = (type: Exclude<ComplaintLinkType, 'Nonconformance'>) => LINK_FIELDS[type]

function mayChange(context: OfficeContext, row: ComplaintRow): void {
  if (row.status !== 'NEW' && !mayOn(context, QUALITY_COMPLAINTS_MANAGE, row)) throw new ForbiddenError('Once triaged, a complaint is changed by quality (quality.complaints.manage).')
}

/** The NCR to link or unlink, as the caller sees it (another company's: not found). */
async function ncrFor(caller: CommandCaller, context: OfficeContext, complaint: ComplaintRow, ncrId: string) {
  const ncr = isUuid(ncrId) ? await caller.withClient((db) => db.nonconformance.findUnique({ where: { id: ncrId }, select: { id: true, number: true, companyId: true, siteId: true, stage: true, sourceType: true, sourceId: true } })) : null
  if (!ncr || !can(actorOf(context), QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId }) || ncr.companyId !== complaint.companyId) throw new NotFoundError("NCR not found among the complaint's company's NCRs.")
  return ncr
}

/** POST /quality/complaints/:complaintId/links */
export async function linkToComplaint(caller: CommandCaller, complaintId: string, body: LinkBody, idempotencyKey?: string) {
  const { context, complaint } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_LOG)
  mayChange(context, complaint)
  if (body.recordType !== 'Nonconformance') {
    const field = factOf(body.recordType)
    if (field === 'serial') {
      const garment = isUuid(body.recordId) ? await caller.withClient((db) => db.garmentSerial.findUnique({ where: { id: body.recordId }, select: { serial: true } })) : null
      if (!garment) throw new NotFoundError('Garment not found.')
      if (complaint.serial && complaint.serial !== garment.serial) throw new ConflictError(`The complaint names garment ${complaint.serial} already: unlink it first.`)
      return changeComplaint(caller, complaintId, { version: body.version, serial: garment.serial }, idempotencyKey)
    }
    const current = complaint[field]
    if (current && current !== body.recordId) throw new ConflictError('The complaint is linked to another one of these already: unlink it first.')
    return changeComplaint(caller, complaintId, { version: body.version, [field]: body.recordId }, idempotencyKey)
  }
  const ncr = await ncrFor(caller, context, complaint, body.recordId)
  if (!can(actorOf(context), QUALITY_NCR_RAISE, { companyId: ncr.companyId, siteId: ncr.siteId })) throw new ForbiddenError(`Linking ${ncr.number} needs quality.ncr.raise at its site.`)
  const { result } = await command(caller, { name: 'complaints.linkNcr', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockComplaint(tools, complaint.id, body.version)
    const locked = await lockNcrRow(tools, ncr.id)
    if (await tx.ncrLink.findFirst({ where: { ncrId: ncr.id, recordType: COMPLAINT_RECORD, recordId: row.id }, select: { id: true } })) throw new ConflictError(`${ncr.number} names this complaint already.`)
    if ((await tx.ncrLink.count({ where: { ncrId: ncr.id } })) >= NCR_LIMITS.links) throw new ConflictError(`An NCR links at most ${NCR_LIMITS.links} records.`)
    const linkId = newId()
    await tx.ncrLink.create({ data: { id: linkId, siteId: locked.siteId, ncrId: ncr.id, recordType: COMPLAINT_RECORD, recordId: row.id, note: null, createdAt: now, createdById: context.actorId }, select: { id: true } })
    const after = await touchComplaint(tools, row)
    tools.audit({ action: 'complaints.linkNcr', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { ncr: { id: ncr.id, number: ncr.number }, version: after.version } })
    tools.audit({ action: 'quality.linkNcr', recordType: NCR_RECORD, recordId: ncr.id, companyId: locked.companyId, siteId: locked.siteId, after: { link: { id: linkId, recordType: COMPLAINT_RECORD, recordId: row.id } } })
    emitChanged(tools, locked, ['links'])
    return { complaintId: row.id }
  })
  return { complaint: await recordOf(caller, result.complaintId), warnings: [] }
}

/** DELETE /quality/complaints/:complaintId/links/:recordType/:recordId?version= */
export async function unlinkFromComplaint(caller: CommandCaller, complaintId: string, target: { readonly recordType: ComplaintLinkType; readonly recordId: string }, query: { readonly version: number }, idempotencyKey?: string) {
  const { context, complaint } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_LOG)
  mayChange(context, complaint)
  if (target.recordType !== 'Nonconformance') {
    const field = factOf(target.recordType)
    if (field === 'serial') {
      const garment = isUuid(target.recordId) ? await caller.withClient((db) => db.garmentSerial.findUnique({ where: { id: target.recordId }, select: { serial: true } })) : null
      if (!garment || complaint.serial !== garment.serial) throw new NotFoundError('The complaint does not name this garment.')
      return changeComplaint(caller, complaintId, { version: query.version, serial: null }, idempotencyKey)
    }
    if (complaint[field] !== target.recordId) throw new NotFoundError('The complaint is not linked to it.')
    return changeComplaint(caller, complaintId, { version: query.version, [field]: null }, idempotencyKey)
  }
  const ncr = await ncrFor(caller, context, complaint, target.recordId)
  if (!can(actorOf(context), QUALITY_NCR_MANAGE, { companyId: ncr.companyId, siteId: ncr.siteId })) throw new ForbiddenError(`Unlinking ${ncr.number} needs quality.ncr.manage at its site.`)
  if (ncr.sourceType === COMPLAINT_RECORD && ncr.sourceId === complaint.id) throw new ConflictError(`${ncr.number} was raised from this complaint: it stays linked.`)
  const { result } = await command(caller, { name: 'complaints.unlinkNcr', idempotencyKey, input: { complaintId, ...target, ...query } }, async (tools) => {
    const { tx } = tools
    const row = await lockComplaint(tools, complaint.id, query.version)
    const locked = await lockNcrRow(tools, ncr.id)
    const link = await tx.ncrLink.findFirst({ where: { ncrId: ncr.id, recordType: COMPLAINT_RECORD, recordId: row.id }, select: { id: true, ncrId: true, recordType: true, recordId: true } })
    if (!link) throw new NotFoundError(`${ncr.number} does not name this complaint.`)
    await tx.ncrLink.delete({ where: { id: link.id }, select: { id: true } })
    const after = await touchComplaint(tools, row)
    tools.audit({ action: 'complaints.unlinkNcr', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { ncr: { id: ncr.id, number: ncr.number }, version: row.version }, after: { version: after.version } })
    tools.audit({ action: 'quality.unlinkNcr', recordType: NCR_RECORD, recordId: ncr.id, companyId: locked.companyId, siteId: locked.siteId, before: { link } })
    emitChanged(tools, locked, ['links'])
    return { complaintId: row.id }
  })
  return { complaint: await recordOf(caller, result.complaintId), warnings: [] }
}

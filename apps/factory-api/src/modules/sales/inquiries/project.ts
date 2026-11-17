import { ValidationError } from '@nexus/factory-domain/core/errors'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { summaryOf } from '@nexus/factory-domain/sales/inquiries/rules'
import type { CommandCaller } from '../../../core/command'
import { createProject } from '../../product/projects/projects'
import { refuse } from '../../product/projects/store'
import { carryFiles, requestFiles } from './carry'
import { officeInquiry } from './store'

/**
 * B-TH-071 (threads plan TH-5, PROJ-G20, PROJ.new-F07; design O-SAL-INQ-LIST.pane-actions "Start a project"; wall W38): a project
 * started from an Incoming request — when a request is the start of development work (a new collection, a style family, a
 * programme) rather than one order.
 *
 *   POST /sales/inquiries/:inquiryId/project    sales.inquiries.view over the request AND projects.manage over its company and
 *                                               customer (createProject checks it): {name?, targetDate, leadId?, goal?,
 *                                               seasonCode?, colleagueIds?, fileIds?}
 *
 * The project's outside company is the REQUEST's customer — never one the body names (W38: a project started from brand A's
 * request is brand A's). A prospect's request (no customer yet) is refused in words (409 refusal/NO_PARTY_REQUEST): a project's
 * outside company never changes later, and a request linked to an office-only project could no longer be matched to its customer
 * (the database keeps a linked record in its project's company) — so the office answers the new customer first. The request is linked
 * to the project at once (its "In project" chip); its name is the request's subject unless typed. The files picked are carried to
 * the project after the command (Use on…, ./carry.ts: the brand wall of the copy holds, a file that cannot be copied is said).
 * The request itself does not change (it stays open: a project does not answer it).
 */

export interface StartProjectBody {
  readonly name?: string | undefined
  readonly targetDate: string
  readonly leadId?: string | undefined
  readonly goal?: string | null | undefined
  readonly seasonCode?: string | null | undefined
  readonly colleagueIds?: readonly string[] | undefined
  readonly fileIds?: readonly string[] | undefined
}

/** POST /sales/inquiries/:inquiryId/project: "Start a project". */
export async function startProjectFromRequest(caller: CommandCaller, inquiryId: string, body: StartProjectBody, idempotencyKey?: string) {
  const { inquiry } = await officeInquiry(caller, inquiryId, SALES_INQUIRIES_VIEW)
  if (inquiry.partyId === null) refuse('NO_PARTY_REQUEST')
  const picked = body.fileIds ?? []
  const files = await requestFiles(caller, inquiry, picked)
  const missing = picked.filter((fileId) => !files.some((file) => file.id === fileId))
  if (missing.length > 0) throw new ValidationError('Pick files of this request (or of its mail) that are available.', missing.map((fileId) => ({ path: `body/fileIds/${picked.indexOf(fileId)}`, message: 'Not an available file of this request.' })))
  const name = body.name?.trim() || summaryOf(inquiry.request).slice(0, 200).trim() || inquiry.number
  const made = await createProject(
    caller,
    {
      companyId: inquiry.companyId,
      name,
      partyId: inquiry.partyId,
      targetDate: body.targetDate,
      ...(body.leadId ? { leadId: body.leadId } : {}),
      ...(body.goal !== undefined ? { goal: body.goal } : {}),
      ...(body.seasonCode !== undefined ? { seasonCode: body.seasonCode } : {}),
      ...(body.colleagueIds ? { colleagueIds: body.colleagueIds } : {}),
      links: [{ recordType: 'Inquiry', recordId: inquiry.id }],
    },
    idempotencyKey,
    { from: { type: 'Inquiry', id: inquiry.id } },
  )
  return { ...made, files: await carryFiles(caller, files, { recordType: 'Project', recordId: made.project.id }, idempotencyKey) }
}

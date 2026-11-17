import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { isProjectLinkType, LINK_GROUPS, lineOf, linkKeyOf, PROJECT_LIMITS, PROJECT_LINES, PROJECT_REFUSALS, PROJECT_LINK_TYPES, type ProjectLinkType, type ProjectRefusalCode, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { viewGateOf } from '@nexus/factory-domain/threads/view-gates'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { recordLabelOf } from '../../../platform/threads/labels'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { assertOpen, badBody, databaseRefusal, managedProject, mayRead, officeOf, PROJECT_COLUMNS, projectOr404, readableWhere, refuse, type ProjectRow, type Reader } from './store'

/**
 * Linked records both ways (threads plan TH-5, B-TH-067; PROJ-G03, PROJ-G12; design PROJ.linked, T1 "In project", the Styles and
 * Samples lists' "Add to project"). Office only; projects.manage over the project.
 *
 *   POST   /projects/:projectId/links              {recordType, recordId, note?}: link a style, sample round, quote, order, PO,
 *                                                  subcontract order, change request, certificate, request, shipment or
 *                                                  measurement profile the person may open (its own view over it); a system
 *                                                  line in the thread ("Linked SR-0042 · by Marco")
 *   POST   /projects/:projectId/links/bulk         {recordType Style | SampleRound, recordIds (≤ 200), note?}: the lists' "Add to
 *                                                  project" — the rows that may join are linked in ONE command, each other row
 *                                                  answered with its reason in words (already linked, another company's …);
 *                                                  one system line for them all
 *   DELETE /projects/:projectId/links/:linkId      unlink (the audit keeps it; a system line); never on a CLOSED project
 *   GET    /projects/of/:recordType/:recordId      "In project" for ANY record: the projects it is linked to that the reader may
 *                                                  open (a project the reader may not open is not shown, PROJ.linked-F05)
 *
 * THE WALL (W38): a project links records of its own company (or tenant-wide), and of its own outside company or of none; an
 * office-only project links only records of none. Another outside company's record is refused in words that name no customer
 * (PROJ.linked-F03); the database (…_projects_th_guards) refuses it again for every login, and refuses a later change that would
 * make a linked record another company's. Nothing is ever copied between the record's thread and the project.
 */

export interface LinkAsk {
  readonly recordType: string
  readonly recordId: string
  readonly note?: string | null | undefined
}

/** A linkable record as its table says (the database's `factory_project_link_columns`): its company and its outside company. */
export interface RecordFacts {
  readonly companyId: string | null
  readonly partyId: string | null
}

/** A linkable record's company and outside company, read in the caller's scope (null: not there for them). */
export async function factsOf(db: Reader, type: ProjectLinkType, id: string): Promise<RecordFacts | null> {
  if (!isUuid(id)) return null
  switch (type) {
    case 'Style': {
      const row = await db.style.findUnique({ where: { id }, select: { companyId: true, brandPartyId: true } })
      return row ? { companyId: row.companyId, partyId: row.brandPartyId } : null
    }
    case 'Certificate': {
      const row = await db.certificate.findUnique({ where: { id }, select: { companyId: true, holderPartyId: true } })
      return row ? { companyId: row.companyId, partyId: row.holderPartyId } : null
    }
    case 'SampleRound':
      return db.sampleRound.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'Quote':
      return db.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'SalesOrder':
      return db.salesOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'PurchaseOrder':
      return db.purchaseOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'SubcontractOrder':
      return db.subcontractOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'ChangeRequest':
      return db.changeRequest.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'Inquiry':
      return db.inquiry.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'Shipment':
      return db.shipment.findUnique({ where: { id }, select: { companyId: true, partyId: true } })
    case 'MeasurementProfile': {
      const row = await db.measurementProfile.findUnique({ where: { id }, select: { partyId: true } })
      return row ? { companyId: null, partyId: row.partyId } : null
    }
  }
}

/** Whether the person may open the record itself (its own view permission over its company and outside company). */
export function mayOpenRecord(actor: Actor, type: string, facts: RecordFacts): boolean {
  const gate = viewGateOf(type)
  return gate !== null && can(actor, gate, { companyId: facts.companyId, siteId: null, partyId: facts.partyId })
}

/** Why this record may not join this project (the wall's codes), or null. */
export function linkRefusal(project: Pick<ProjectRow, 'companyId' | 'partyId'>, facts: RecordFacts): ProjectRefusalCode | null {
  if (facts.companyId !== null && facts.companyId !== project.companyId) return 'LINK_COMPANY'
  if (facts.partyId !== null && project.partyId === null) return 'LINK_OFFICE_ONLY'
  if (facts.partyId !== null && facts.partyId !== project.partyId) return 'LINK_PARTY'
  return null
}

export type LinkOutcome = { readonly linked: true; readonly linkId: string; readonly label: string } | { readonly linked: false; readonly code: ProjectRefusalCode }

/**
 * Inside a command: links one record to an open project, or says why not (`quiet`: no system line, the caller writes one for a
 * batch). A record the person may not open is 404 (`at` names it), like one that does not exist: the reader learns nothing.
 */
export async function linkInCommand(tools: CommandTools, actor: Actor, project: ProjectRow, ask: LinkAsk, at = 'body', options: { readonly quiet?: boolean; readonly soft?: boolean } = {}): Promise<LinkOutcome> {
  assertOpen(project.status)
  if (!isProjectLinkType(ask.recordType)) {
    if (options.soft) return { linked: false, code: 'LINK_TYPE' }
    refuse('LINK_TYPE', `${at}/recordType`)
  }
  const type = ask.recordType as ProjectLinkType
  const facts = await factsOf(tools.tx, type, ask.recordId)
  if (!facts || !mayOpenRecord(actor, type, facts)) throw new NotFoundError('Record not found.')
  const refusal = linkRefusal(project, facts)
  if (refusal) {
    if (options.soft) return { linked: false, code: refusal }
    refuse(refusal, `${at}/recordId`)
  }
  const key = linkKeyOf(project.id, type, ask.recordId)
  if (await tools.tx.projectLink.findFirst({ where: { key }, select: { id: true } })) {
    if (options.soft) return { linked: false, code: 'ALREADY_LINKED' }
    refuse('ALREADY_LINKED', `${at}/recordId`)
  }
  const note = ask.note && ask.note.trim() !== '' ? ask.note.trim() : null
  if (note !== null && (note.length > PROJECT_LIMITS.linkNote || /[\u0000-\u001f\u007f]/.test(note))) badBody(at === 'body' ? 'note' : `${at.slice('body/'.length)}/note`, `The note is one line of up to ${PROJECT_LIMITS.linkNote} characters.`)
  const id = newId()
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tools.tx.projectLink.create({ data: { id, projectId: project.id, recordType: type, recordId: ask.recordId, key, note, createdAt: tools.now, createdById }, select: { id: true } })
  const label = (await recordLabelOf(tools.tx, type, ask.recordId)) ?? type
  tools.audit({ action: 'projects.link', recordType: 'Project', recordId: project.id, companyId: project.companyId, after: { linkId: id, recordType: type, recordId: ask.recordId, label, note: note === null ? null : 'set' } })
  tools.emit({ type: 'project.linked', subject: project.id, companyId: project.companyId, payload: { projectId: project.id, number: project.number, partyId: project.partyId, linkId: id, recordType: type, recordId: ask.recordId } })
  if (!options.quiet) await systemLine(tools, project, lineOf(PROJECT_LINES.linked(label, await nameOf(tools, createdById))))
  return { linked: true, linkId: id, label }
}

const nameOf = async (tools: Pick<CommandTools, 'tx'>, userId: string | null): Promise<string> =>
  userId ? ((await tools.tx.user.findUnique({ where: { id: userId }, select: { displayName: true } }))?.displayName ?? '') : 'Nexus'

/** A system line in the project's thread (an internal note: the office reads it; the outside company never does). */
async function systemLine(tools: CommandTools, project: Pick<ProjectRow, 'id'>, text: string): Promise<void> {
  const { thread } = await ensureThread(tools, { type: 'Project', id: project.id }, tools.context.audience === 'office' ? tools.context.actorId : null)
  if (thread.status !== 'OPEN') return
  await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text) })
}

/** POST /projects/:projectId/links */
export async function linkRecord(caller: CommandCaller, projectId: string, body: LinkAsk, idempotencyKey?: string) {
  const { actor, row: seen } = await managedProject(caller, projectId)
  assertOpen(seen.status)
  const { result } = await command(caller, { name: 'projects.link', idempotencyKey, input: { projectId, ...body } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    const outcome = await linkInCommand(tools, actor, row, body)
    return outcome.linked ? { linkId: outcome.linkId } : { linkId: null }
  }).catch(databaseRefusal)
  return { link: { id: result.linkId!, recordType: body.recordType, recordId: body.recordId }, links: await linksOfProject(caller, projectId) }
}

/** POST /projects/:projectId/links/bulk: the Styles and Samples lists' "Add to project". */
export async function linkMany(caller: CommandCaller, projectId: string, body: { readonly recordType: 'Style' | 'SampleRound'; readonly recordIds: readonly string[]; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const { context, actor, row: seen } = await managedProject(caller, projectId)
  assertOpen(seen.status)
  const ids = [...new Set(body.recordIds)]
  if (ids.length === 0 || ids.length > PROJECT_LIMITS.bulk) badBody('recordIds', `Pick 1 to ${PROJECT_LIMITS.bulk} records.`)
  const { result } = await command(caller, { name: 'projects.linkMany', idempotencyKey, input: { projectId, ...body, recordIds: ids } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    const linked: { recordId: string; linkId: string; label: string }[] = []
    const skipped: { recordId: string; code: string; words: { it: string; en: string } }[] = []
    for (const recordId of ids) {
      let outcome: LinkOutcome
      try {
        outcome = await linkInCommand(tools, actor, row, { recordType: body.recordType, recordId, note: body.note ?? null }, 'body', { quiet: true, soft: true })
      } catch (error) {
        // A record the person may not open is skipped as missing (named by its id only: never what it is).
        if (error instanceof NotFoundError) {
          skipped.push({ recordId, code: 'MISSING', words: { it: 'Record non trovato.', en: 'Record not found.' } })
          continue
        }
        throw error
      }
      if (outcome.linked) linked.push({ recordId, linkId: outcome.linkId, label: outcome.label })
      else skipped.push({ recordId, code: outcome.code, words: PROJECT_REFUSALS[outcome.code] })
    }
    if (linked.length > 0) {
      const by = await nameOf(tools, context.actorId)
      const labels = linked.slice(0, 10).map((entry) => entry.label).join(', ') + (linked.length > 10 ? ` +${linked.length - 10}` : '')
      await systemLine(tools, row, lineOf(PROJECT_LINES.linked(labels, by)))
    } else {
      tools.audit({ action: 'projects.linkManyNone', recordType: 'Project', recordId: row.id, companyId: row.companyId, after: { asked: ids.length, skipped: skipped.length } })
    }
    return { linked, skipped }
  }).catch(databaseRefusal)
  return { linked: result.linked.length, skipped: result.skipped, links: await linksOfProject(caller, projectId) }
}

/** DELETE /projects/:projectId/links/:linkId */
export async function unlinkRecord(caller: CommandCaller, projectId: string, linkId: string, idempotencyKey?: string) {
  const { context, row: seen } = await managedProject(caller, projectId)
  assertOpen(seen.status)
  await command(caller, { name: 'projects.unlink', idempotencyKey, input: { projectId, linkId } }, async (tools) => {
    const row = await projectOr404(tools.tx, projectId)
    assertOpen(row.status)
    const link = isUuid(linkId) ? await tools.tx.projectLink.findFirst({ where: { id: linkId, projectId }, select: { id: true, recordType: true, recordId: true } }) : null
    if (!link) throw new NotFoundError('Link not found.')
    await tools.tx.projectLink.delete({ where: { id: link.id } })
    const label = (await recordLabelOf(tools.tx, link.recordType, link.recordId)) ?? link.recordType
    tools.audit({ action: 'projects.unlink', recordType: 'Project', recordId: row.id, companyId: row.companyId, before: { linkId: link.id, recordType: link.recordType, recordId: link.recordId, label } })
    tools.emit({ type: 'project.unlinked', subject: row.id, companyId: row.companyId, payload: { projectId: row.id, number: row.number, partyId: row.partyId, linkId: link.id, recordType: link.recordType, recordId: link.recordId } })
    await systemLine(tools, row, lineOf(PROJECT_LINES.unlinked(label, await nameOf(tools, context.actorId))))
    return { linkId: link.id }
  }).catch(databaseRefusal)
  return { links: await linksOfProject(caller, projectId) }
}

// ---- reads ----------------------------------------------------------------------------------------------------------------

export interface LinkedRecordView {
  readonly linkId: string
  readonly recordType: string
  readonly recordId: string
  readonly group: string
  /** Its number or code; null when the reader may not open the record (the row says "you cannot open it", PROJ.linked-F10). */
  readonly label: string | null
  readonly status: string | null
  readonly mayOpen: boolean
  readonly note: string | null
  readonly linkedAt: string
  readonly linkedBy: { readonly id: string; readonly name: string } | null
}

/** A record's status code, read in the caller's scope (null: not one of ours to show). */
async function statusOf(db: Reader, type: string, id: string): Promise<string | null> {
  switch (type) {
    case 'Style':
      return (await db.style.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'SampleRound':
      return (await db.sampleRound.findUnique({ where: { id }, select: { stage: true } }))?.stage ?? null
    case 'Quote':
      return (await db.quote.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'SalesOrder':
      return (await db.salesOrder.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'PurchaseOrder':
      return (await db.purchaseOrder.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'SubcontractOrder':
      return (await db.subcontractOrder.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'ChangeRequest':
      return (await db.changeRequest.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'Certificate':
      return (await db.certificate.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'Inquiry':
      return (await db.inquiry.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    case 'Shipment':
      return (await db.shipment.findUnique({ where: { id }, select: { status: true } }))?.status ?? null
    default:
      return null
  }
}

/** The project's links as this office reader sees them: grouped by kind, a record they may not open by its kind only. */
export async function linkedViewsOf(db: Reader, actor: Actor, projectId: string): Promise<{ count: number; records: LinkedRecordView[] }> {
  const where = { projectId }
  const count = await db.projectLink.count({ where })
  const rows = await db.projectLink.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PROJECT_LIMITS.links, select: { id: true, recordType: true, recordId: true, note: true, createdAt: true, createdById: true } })
  const names = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.createdById ? [row.createdById] : [])))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const records: LinkedRecordView[] = []
  for (const row of rows) {
    const type = row.recordType as ProjectLinkType
    const facts = isProjectLinkType(type) ? await factsOf(db, type, row.recordId) : null
    const mayOpen = facts !== null && mayOpenRecord(actor, type, facts)
    records.push({
      linkId: row.id,
      recordType: row.recordType,
      recordId: row.recordId,
      group: LINK_GROUPS[type] ?? 'OTHER',
      label: mayOpen ? await recordLabelOf(db, type, row.recordId) : null,
      status: mayOpen ? await statusOf(db, type, row.recordId) : null,
      mayOpen,
      note: row.note,
      linkedAt: toUtcIso(row.createdAt),
      linkedBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? '' } : null,
    })
  }
  const order = PROJECT_LINK_TYPES.map((type) => LINK_GROUPS[type])
  records.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
  return { count, records }
}

async function linksOfProject(caller: CommandCaller, projectId: string) {
  const context = officeOf(caller)
  return caller.withClient((db) => linkedViewsOf(db, actorOf(context), projectId))
}

/** GET /projects/of/:recordType/:recordId: the record's "In project" chip (first one + "+2"). */
export async function projectsOfRecord(caller: CommandCaller, recordType: string, recordId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!isProjectLinkType(recordType)) return { projects: [], count: 0 }
  return caller.withClient(async (db) => {
    const facts = await factsOf(db, recordType, recordId)
    if (!facts || !mayOpenRecord(actor, recordType, facts)) throw new NotFoundError('Record not found.')
    const links = await db.projectLink.findMany({ where: { recordType, recordId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PROJECT_LIMITS.links, select: { projectId: true } })
    const rows = links.length === 0 ? [] : await db.project.findMany({ where: { AND: [readableWhere(actor), { id: { in: links.map((link) => link.projectId) } }] }, select: PROJECT_COLUMNS })
    const order = links.map((link) => link.projectId)
    const shown = rows.filter((row) => mayRead(actor, row)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    return { count: shown.length, projects: shown.map((row) => ({ id: row.id, number: row.number, name: row.name, status: row.status as ProjectStatus })) }
  })
}

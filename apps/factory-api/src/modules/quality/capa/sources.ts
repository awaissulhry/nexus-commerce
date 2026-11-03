import { ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUALITY_CAPA_MANAGE, QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { CAPA_LIMITS, CAPA_RECORD, complaintReasons, ncrReasons, REPEAT_DAYS, STATUS_WORDS, type CapaStatus, type EscalationReason, type SourceType } from '@nexus/factory-domain/quality/capa/rules'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { QUALITY_NCR_MANAGE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertOpen, held, officeCapa, officeOf, refuse } from './access'
import { answerOf, lockCapaRow } from './capa'
import { CAPA_COLUMNS, customersOf, type CapaRow, type Reader } from './store'

/**
 * Escalate to CAPA (B-W2b-108; QHS-087, which closes B-W2a-47's gap; design quality.ncr ncr-capa "Link to an open CAPA or
 * start a new one; many NCRs → one CAPA; the rule that suggested it", quality.complaints "links to NCR and CAPA"): the
 * records a CAPA comes from. One CAPA per record (a record already a source of a CAPA that is not cancelled is refused in
 * words); the NCR names its CAPA too (Nonconformance.capaId), the complaint does not (it has no column: its CAPA is found
 * through the source).
 *
 *   GET    /quality/capa/escalate?recordType=&ids=   the preview of ncr-capa: each record, whether it can go and why
 *                                                    not, the rule that suggests it, and the open CAPAs of its company
 *   POST   /quality/capa/:capaId/sources             escalate records to an open CAPA (POST /quality/capa does it for a
 *                                                    new one, in the same command)
 *   DELETE /quality/capa/:capaId/sources/:sourceId   take one off while the CAPA is open
 *
 * Inside the command, in this order: the CAPA's row FOR UPDATE (the caller's), then per record (sorted) the record's
 * escalation lock `factory.capa-source|<recordId>` (two CAPAs never take one record at once), then the NCR's row FOR
 * UPDATE; the source row first, then the NCR's capaId (one UPDATE of capaId, version and updatedAt: allowed on a DECIDED or
 * CLOSED NCR once, never on a CANCELLED one). An NCR needs quality.ncr.manage at its site (it changes); a complaint
 * quality.complaints.view over its customer (it does not). Taking an NCR off clears its capaId first: refused once the NCR
 * is DECIDED or CLOSED (it keeps it).
 */

export interface SourceInput {
  readonly recordType: SourceType
  readonly recordId: string
  /** Why it is escalated, in words (the rule that suggested it: "repeat defect", "critical", "customer complaint"). */
  readonly note?: string | null | undefined
}

const NCR_SELECT = { id: true, companyId: true, siteId: true, number: true, title: true, stage: true, severity: true, source: true, capaId: true, defectCodeId: true, styleId: true, foundOn: true } as const
const COMPLAINT_SELECT = { id: true, companyId: true, partyId: true, number: true, status: true, category: true } as const

/** The record's escalation lock: two CAPAs never take one record at once. */
async function lockRecord(tx: CommandTx, recordId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.capa-source', ${recordId}::uuid), 0))`
}

/** The CAPAs a record is a source of (any), with their state. */
async function capasOfRecord(db: Reader, recordType: SourceType, recordId: string) {
  const rows = await db.capaSource.findMany({ where: { recordType, recordId }, select: { id: true, capaId: true, capa: { select: { id: true, number: true, status: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return rows.map((row) => ({ sourceId: row.id, capaId: row.capaId, number: row.capa.number, status: row.capa.status as CapaStatus }))
}

/** How many other NCRs found the same library defect (on the same style when it names one) within REPEAT_DAYS. */
async function repeatsOf(db: Reader, ncr: { id: string; defectCodeId: string | null; styleId: string | null; foundOn: Date }): Promise<number> {
  if (!ncr.defectCodeId) return 0
  const since = new Date(ncr.foundOn.getTime() - REPEAT_DAYS * 86_400_000)
  return db.nonconformance.count({ where: { id: { not: ncr.id }, defectCodeId: ncr.defectCodeId, ...(ncr.styleId ? { styleId: ncr.styleId } : {}), stage: { not: 'CANCELLED' }, foundOn: { gte: since } } })
}

/**
 * Adds the sources inside the caller's command (the CAPA's row is locked by it, open): each record checked, its source row,
 * the NCR's capaId. Answers how many were added (a record already a source of this CAPA adds nothing; an NCR of it that
 * does not name it yet is made to name it).
 */
export async function addSourcesInCommand(tools: CommandTools, capa: CapaRow, sources: readonly SourceInput[], context: OfficeContext): Promise<number> {
  const { tx, now } = tools
  const actor = actorOf(context)
  const seen = new Set<string>()
  const wanted = sources
    .map((source, index) => ({ ...source, index }))
    .filter((source) => {
      const key = `${source.recordType}|${source.recordId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
  let added = 0
  for (const source of wanted) {
    const at = `sources/${source.index}/recordId`
    const note = source.note?.trim() ? source.note.trim().slice(0, CAPA_LIMITS.note) : null
    if (!isUuid(source.recordId)) refuse([{ path: at, message: 'Not a record you can see.' }], 'A record is not found.')
    await lockRecord(tx, source.recordId)
    const existing = await capasOfRecord(tx, source.recordType, source.recordId)
    const others = existing.filter((other) => other.capaId !== capa.id && other.status !== 'CANCELLED')
    const already = existing.some((other) => other.capaId === capa.id)

    if (source.recordType === 'Nonconformance') {
      await tx.$queryRaw`SELECT "id" FROM "Nonconformance" WHERE "id" = ${source.recordId}::uuid FOR UPDATE`
      const ncr = await tx.nonconformance.findUnique({ where: { id: source.recordId }, select: NCR_SELECT })
      if (!ncr || !can(actor, QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId })) refuse([{ path: at, message: 'Not an NCR you can see.' }], 'An NCR is not found.')
      if (!can(actor, QUALITY_NCR_MANAGE, { companyId: ncr!.companyId, siteId: ncr!.siteId })) throw new ForbiddenError(`Escalating ${ncr!.number} needs quality.ncr.manage at its site.`)
      if (ncr!.companyId !== capa.companyId) throw held('OTHER_COMPANY', `${ncr!.number} is another company's: a CAPA takes the records of its own company.`)
      if (ncr!.stage === 'CANCELLED') throw held('NCR_CANCELLED', `${ncr!.number} is cancelled: it is escalated to no CAPA.`)
      if (others.length > 0) throw held('ESCALATED_ELSEWHERE', `${ncr!.number} is escalated to ${others[0]!.number} already.`)
      if (ncr!.capaId && ncr!.capaId !== capa.id && (ncr!.stage === 'DECIDED' || ncr!.stage === 'CLOSED')) {
        const named = await tx.capa.findUnique({ where: { id: ncr!.capaId }, select: { number: true } })
        throw held('NCR_KEEPS_CAPA', `${ncr!.number} is ${ncr!.stage === 'CLOSED' ? 'closed' : 'decided'} and keeps ${named?.number ?? 'its CAPA'}.`)
      }
      if (!already) {
        const id = newId()
        await tx.capaSource.create({ data: { id, capaId: capa.id, recordType: 'Nonconformance', recordId: ncr!.id, note, createdAt: now, createdById: context.actorId }, select: { id: true } })
        tools.audit({ action: 'quality.addCapaSource', recordType: CAPA_RECORD, recordId: capa.id, companyId: capa.companyId, after: { sourceId: id, recordType: 'Nonconformance', recordId: ncr!.id, number: ncr!.number, note } })
        tools.emit({ type: 'capa.sources_changed', subject: capa.id, companyId: capa.companyId, payload: { capaId: capa.id, number: capa.number, change: 'ADDED', recordType: 'Nonconformance', recordId: ncr!.id } })
        added++
      }
      if (ncr!.capaId !== capa.id) {
        await tx.nonconformance.update({ where: { id: ncr!.id }, data: { capaId: capa.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'quality.escalateNcr', recordType: 'Nonconformance', recordId: ncr!.id, companyId: ncr!.companyId, siteId: ncr!.siteId, before: { capaId: ncr!.capaId }, after: { capaId: capa.id, capaNumber: capa.number } })
        tools.emit({ type: 'ncr.changed', subject: ncr!.id, companyId: ncr!.companyId, siteId: ncr!.siteId, payload: { ncrId: ncr!.id, number: ncr!.number, fields: ['links'] } })
      }
      continue
    }

    const complaint = await tx.complaint.findUnique({ where: { id: source.recordId }, select: COMPLAINT_SELECT })
    if (!complaint || !can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: complaint.companyId, partyId: complaint.partyId })) refuse([{ path: at, message: 'Not a complaint you can see.' }], 'A complaint is not found.')
    if (complaint!.companyId !== capa.companyId) throw held('OTHER_COMPANY', `${complaint!.number} is another company's: a CAPA takes the records of its own company.`)
    if (others.length > 0) throw held('ESCALATED_ELSEWHERE', `${complaint!.number} is escalated to ${others[0]!.number} already.`)
    if (already) continue
    const id = newId()
    await tx.capaSource.create({ data: { id, capaId: capa.id, recordType: 'Complaint', recordId: complaint!.id, note, createdAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'quality.addCapaSource', recordType: CAPA_RECORD, recordId: capa.id, companyId: capa.companyId, after: { sourceId: id, recordType: 'Complaint', recordId: complaint!.id, number: complaint!.number, note } })
    tools.emit({ type: 'capa.sources_changed', subject: capa.id, companyId: capa.companyId, payload: { capaId: capa.id, number: capa.number, change: 'ADDED', recordType: 'Complaint', recordId: complaint!.id } })
    added++
  }
  return added
}

/** POST /quality/capa/:capaId/sources {sources, version?}: escalate records to an open CAPA. */
export async function addSources(caller: CommandCaller, capaId: string, body: { readonly version?: number | undefined; readonly sources: readonly SourceInput[] }, idempotencyKey?: string) {
  const { context, capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  if (body.sources.length === 0) refuse([{ path: 'sources', message: 'Name the NCRs or complaints to escalate.' }], 'Name the records.')
  if (body.sources.length > CAPA_LIMITS.sources) refuse([{ path: 'sources', message: `At most ${CAPA_LIMITS.sources} records at once.` }], 'Too many records.')
  const { result } = await command(caller, { name: 'quality.addCapaSources', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const row = await lockCapaRow(tools, capaId, { version: body.version, bump: false })
    const added = await addSourcesInCommand(tools, row, body.sources, context)
    if (added > 0) await tools.tx.capa.update({ where: { id: capaId }, data: { version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    return { ...(await answerOf(tools, capaId)), added }
  })
  return result
}

/** DELETE /quality/capa/:capaId/sources/:sourceId?version=: take a record off an open CAPA. */
export async function removeSource(caller: CommandCaller, capaId: string, sourceId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const { context, capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'quality.removeCapaSource', idempotencyKey, input: { capaId, sourceId, ...query } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockCapaRow(tools, capaId, { version: query.version, bump: false })
    const source = isUuid(sourceId) ? await tx.capaSource.findFirst({ where: { id: sourceId, capaId }, select: { id: true, recordType: true, recordId: true, note: true } }) : null
    if (!source) throw new NotFoundError('Source not found.')
    await lockRecord(tx, source.recordId)
    if (source.recordType === 'Nonconformance') {
      await tx.$queryRaw`SELECT "id" FROM "Nonconformance" WHERE "id" = ${source.recordId}::uuid FOR UPDATE`
      const ncr = await tx.nonconformance.findUnique({ where: { id: source.recordId }, select: NCR_SELECT })
      if (ncr && ncr.capaId === capaId) {
        if (!can(actor, QUALITY_NCR_MANAGE, { companyId: ncr.companyId, siteId: ncr.siteId })) throw new ForbiddenError(`Taking ${ncr.number} off needs quality.ncr.manage at its site.`)
        if (ncr.stage === 'DECIDED' || ncr.stage === 'CLOSED') throw held('NCR_KEEPS_CAPA', `${ncr.number} is ${ncr.stage === 'CLOSED' ? 'closed' : 'decided'}: it stays escalated to ${row.number}.`)
        await tx.nonconformance.update({ where: { id: ncr.id }, data: { capaId: null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'quality.unescalateNcr', recordType: 'Nonconformance', recordId: ncr.id, companyId: ncr.companyId, siteId: ncr.siteId, before: { capaId }, after: { capaId: null } })
        tools.emit({ type: 'ncr.changed', subject: ncr.id, companyId: ncr.companyId, siteId: ncr.siteId, payload: { ncrId: ncr.id, number: ncr.number, fields: ['links'] } })
      }
    }
    await tx.capaSource.delete({ where: { id: source.id }, select: { id: true } })
    await tx.capa.update({ where: { id: capaId }, data: { version: { increment: 1 }, updatedAt: now }, select: CAPA_COLUMNS })
    tools.audit({ action: 'quality.removeCapaSource', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { sourceId: source.id, recordType: source.recordType, recordId: source.recordId, note: source.note }, after: null })
    tools.emit({ type: 'capa.sources_changed', subject: capaId, companyId: row.companyId, payload: { capaId, number: row.number, change: 'REMOVED', recordType: source.recordType as SourceType, recordId: source.recordId } })
    return answerOf(tools, capaId)
  })
  return result
}

// ---- the preview of ncr-capa --------------------------------------------------------------------------------------------

/** GET /quality/capa/escalate?recordType=&ids=a,b: what escalating these records would do, and the open CAPAs to link to. */
export async function escalationPreview(caller: CommandCaller, query: { readonly recordType: SourceType; readonly ids: string }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const ids = [...new Set(query.ids.split(',').map((id) => id.trim()).filter((id) => id !== ''))]
  if (ids.length === 0 || ids.length > CAPA_LIMITS.preview || ids.some((id) => !isUuid(id))) refuse([{ path: 'query/ids', message: `Name 1 to ${CAPA_LIMITS.preview} records by id, comma separated.` }], 'Name the records.')
  return caller.withClient(async (client) => {
    const records: {
      recordType: SourceType
      recordId: string
      number: string
      title: string | null
      companyId: string
      state: string
      reasons: EscalationReason[]
      escalatedTo: { capaId: string; number: string; status: CapaStatus } | null
      problem: Issue | null
    }[] = []
    for (const id of ids) {
      const capas = (await capasOfRecord(client, query.recordType, id)).filter((capa) => capa.status !== 'CANCELLED')
      const escalatedTo = capas[0] ? { capaId: capas[0].capaId, number: capas[0].number, status: capas[0].status } : null
      if (query.recordType === 'Nonconformance') {
        const ncr = await client.nonconformance.findUnique({ where: { id }, select: NCR_SELECT })
        if (!ncr || !can(actor, QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId })) throw new NotFoundError('NCR not found.')
        const named = ncr.capaId && !escalatedTo ? await client.capa.findUnique({ where: { id: ncr.capaId }, select: { id: true, number: true, status: true } }) : null
        const problem =
          ncr.stage === 'CANCELLED'
            ? { path: 'held/NCR_CANCELLED', message: `${ncr.number} is cancelled.` }
            : escalatedTo
              ? { path: 'held/ESCALATED_ELSEWHERE', message: `${ncr.number} is escalated to ${escalatedTo.number} (${STATUS_WORDS[escalatedTo.status]}).` }
              : named && named.status === 'CANCELLED' && (ncr.stage === 'DECIDED' || ncr.stage === 'CLOSED')
                ? { path: 'held/NCR_KEEPS_CAPA', message: `${ncr.number} is ${ncr.stage === 'CLOSED' ? 'closed' : 'decided'} and keeps the cancelled ${named.number}.` }
                : !can(actor, QUALITY_NCR_MANAGE, { companyId: ncr.companyId, siteId: ncr.siteId })
                  ? { path: 'held/NO_PERMISSION', message: `Escalating ${ncr.number} needs quality.ncr.manage at its site.` }
                  : null
        records.push({ recordType: 'Nonconformance', recordId: id, number: ncr.number, title: ncr.title, companyId: ncr.companyId, state: ncr.stage, reasons: ncrReasons({ severity: ncr.severity, source: ncr.source, repeats: await repeatsOf(client, ncr) }), escalatedTo, problem })
      } else {
        const complaint = await client.complaint.findUnique({ where: { id }, select: COMPLAINT_SELECT })
        if (!complaint || !can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: complaint.companyId, partyId: complaint.partyId })) throw new NotFoundError('Complaint not found.')
        records.push({
          recordType: 'Complaint',
          recordId: id,
          number: complaint.number,
          title: null,
          companyId: complaint.companyId,
          state: complaint.status,
          reasons: complaintReasons({ category: complaint.category }),
          escalatedTo,
          problem: escalatedTo ? { path: 'held/ESCALATED_ELSEWHERE', message: `${complaint.number} is escalated to ${escalatedTo.number} (${STATUS_WORDS[escalatedTo.status]}).` } : null,
        })
      }
    }
    const companies = [...new Set(records.map((record) => record.companyId))]
    const companyId = companies.length === 1 ? companies[0]! : null
    // The open CAPAs of that company the caller may add to (the Combobox), newest first.
    const open = companyId && can(actor, QUALITY_CAPA_MANAGE, { companyId })
      ? await client.capa.findMany({ where: { companyId, status: { notIn: ['CLOSED', 'CANCELLED'] } }, select: CAPA_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })
      : []
    const visible = open.filter((row) => can(actor, QUALITY_CAPA_MANAGE, { companyId: row.companyId, ...(row.customerId ? { partyId: row.customerId } : {}) })).slice(0, 50)
    const customers = await customersOf(client, visible)
    return {
      records,
      companyId,
      /** Many records go to one CAPA only when they are of one company. */
      sameCompany: companies.length <= 1,
      ready: companies.length <= 1 && records.every((record) => record.problem === null),
      capas: visible.map((row) => ({ id: row.id, number: row.number, title: row.title, type: row.type, status: row.status as CapaStatus, customer: row.customerId ? (customers.get(row.customerId) ?? null) : null, version: row.version })),
      mayOpen: companyId !== null && can(actor, QUALITY_CAPA_MANAGE, { companyId }),
      mayView: companyId !== null && can(actor, QUALITY_CAPA_VIEW, { companyId }),
      asOf: serverClock.now().toISOString(),
    }
  })
}

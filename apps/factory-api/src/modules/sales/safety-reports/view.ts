import { REGISTER_MANAGE } from '@nexus/factory-domain/compliance/register/permissions'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SAFETY_INJURY, SALES_SAFETY_LOG, SALES_SAFETY_MANAGE } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { logStateOf, reportActions, SAFETY_LAW, SOURCE_WORDS, type AccidentOutcome, type ReportStatus, type SafetySource } from '@nexus/factory-domain/sales/safety-reports/rules'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { mayOn, officeOf } from './access'
import { dayOrNull, injuryStateOf, iso, peopleOf, photosOf, readReport, revisionsOf, revisionView, type Reader, type ReportRow } from './store'

/**
 * GET /sales/safety-reports/:reportId — the record (B-W2b-351): where it came from, the garment, what happened, the SAFETY case
 * it opened, its PPE register entry, its photos (opened one by one, each opening recorded), its accident log, its owner and who
 * saw it. Whether someone was hurt is NOT here: `injury` says only whether the report says (`recorded`) and whether the caller
 * may open it (the product-safety role, POST …/injury/open, each opening recorded). The reporter's personal data is shown to
 * the roles that manage reports only (null with `reporterHidden` otherwise).
 */

/** One list row (no reporter, no words of what happened: the record has them). */
export async function rowFacts(db: Reader, rows: readonly ReportRow[]) {
  const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
  const partyIds = unique(rows.map((row) => row.partyId))
  const styleIds = unique(rows.map((row) => row.styleId))
  const caseIds = unique(rows.map((row) => row.serviceCaseId))
  const ids = rows.map((row) => row.id)
  const parties = partyIds.length ? await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } }) : []
  const styles = styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const cases = caseIds.length ? await db.serviceCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, number: true, status: true } }) : []
  const logs = ids.length ? await db.accidentLogEntry.findMany({ where: { reportId: { in: ids } }, select: { reportId: true, revision: true, outcome: true, authorityToldAt: true }, orderBy: [{ reportId: 'asc' }, { revision: 'desc' }] }) : []
  const newest = new Map<string, { outcome: AccidentOutcome; authorityToldAt: Date | null }>()
  for (const entry of logs) if (!newest.has(entry.reportId)) newest.set(entry.reportId, { outcome: entry.outcome as AccidentOutcome, authorityToldAt: entry.authorityToldAt })
  const byId = <T extends { id: string }>(list: readonly T[]) => new Map(list.map((row) => [row.id, row]))
  return { partyOf: byId(parties), styleOf: byId(styles), caseOf: byId(cases), logOf: newest }
}

export type RowFacts = Awaited<ReturnType<typeof rowFacts>>

export function rowView(row: ReportRow, facts: RowFacts) {
  const party = row.partyId ? facts.partyOf.get(row.partyId) : undefined
  const style = row.styleId ? facts.styleOf.get(row.styleId) : undefined
  const serviceCase = row.serviceCaseId ? facts.caseOf.get(row.serviceCaseId) : undefined
  const newest = facts.logOf.get(row.id) ?? null
  const log = logStateOf(newest)
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    source: row.source as SafetySource,
    receivedAt: toUtcIso(row.receivedAt),
    status: row.status as ReportStatus,
    seen: row.seenAt !== null,
    party: party ? { id: party.id, code: party.code, legalName: party.legalName } : null,
    style: style ? { id: style.id, code: style.code, name: style.name } : null,
    serial: row.serial,
    garmentSerial: row.garmentSerial,
    batchNumber: row.batchNumber,
    garmentBatch: row.garmentBatch,
    size: row.size,
    occurredOn: dayOrNull(row.occurredOn),
    case: serviceCase ? { id: serviceCase.id, number: serviceCase.number, status: serviceCase.status } : null,
    filed: row.registerEntryId !== null,
    accident: newest ? { outcome: newest.outcome, told: log.told, mustTell: log.mustTell } : null,
    ownerId: row.ownerId,
    version: row.version,
  }
}

export async function reportView(db: Reader, row: ReportRow, context: OfficeContext) {
  const facts = await rowFacts(db, [row])
  const base = rowView(row, facts)
  const contact = row.contactId ? await db.partyContact.findUnique({ where: { id: row.contactId }, select: { id: true, name: true } }) : null
  const colourway = row.colourwayId ? await db.colourway.findUnique({ where: { id: row.colourwayId }, select: { id: true, code: true, name: true } }) : null
  const entry = row.registerEntryId ? await db.ppeRegisterEntry.findUnique({ where: { id: row.registerEntryId }, select: { id: true, reference: true, status: true } }) : null
  const revisions = await revisionsOf(db, row.id)
  const newest = revisions[0] ?? null
  const photos = await photosOf(db, row.id)
  const injury = await injuryStateOf(db, row.id)
  const may = {
    manage: mayOn(context, SALES_SAFETY_MANAGE, row),
    injury: mayOn(context, SALES_SAFETY_INJURY, row),
    log: mayOn(context, SALES_SAFETY_LOG, row),
    openRegister: mayOn(context, REGISTER_MANAGE, { companyId: row.companyId, partyId: null }),
  }
  const reporterKept = row.reporterName !== null || row.reporterEmail !== null || row.reporterPhone !== null
  return {
    ...base,
    sourceWords: SOURCE_WORDS[row.source as SafetySource],
    contact: contact ? { id: contact.id, name: contact.name } : null,
    /** The reporter as they gave themselves (personal data): for the roles that manage reports. */
    reporter: may.manage ? { name: row.reporterName, email: row.reporterEmail, phone: row.reporterPhone } : null,
    reporterHidden: !may.manage && reporterKept,
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    whatHappened: row.whatHappened,
    wornAsIntended: row.wornAsIntended,
    seenAt: iso(row.seenAt),
    seenById: row.seenById,
    registerEntry: entry ? { id: entry.id, reference: entry.reference, status: entry.status } : null,
    closed: row.closedAt ? { at: toUtcIso(row.closedAt), byId: row.closedById, note: row.closeNote } : null,
    injury: { recorded: injury !== null, mayOpen: may.injury && injury !== null },
    accidentLog: { revisions: revisions.length, newest: newest ? revisionView(newest) : null, state: logStateOf(newest ? { outcome: newest.outcome as AccidentOutcome, authorityToldAt: newest.authorityToldAt } : null), law: SAFETY_LAW.log, q37: SAFETY_LAW.q37 },
    photos,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    actions: reportActions({
      status: row.status as ReportStatus,
      seen: row.seenAt !== null,
      filed: row.registerEntryId !== null,
      hasStyle: row.styleId !== null,
      photos: photos.length,
      reporterKept,
      injury: injury ? { words: injury.words, erased: injury.erased } : null,
      mayManage: may.manage,
      mayInjury: may.injury,
      mayLog: may.log,
      mayOpenRegister: may.openRegister,
    }),
    people: await peopleOf(db, [row.ownerId, row.seenById, row.closedById, row.createdById, newest?.authorityToldById, newest?.createdById]),
  }
}

export type ReportView = Awaited<ReturnType<typeof reportView>>

export async function reportRecordOf(caller: CommandCaller, reportId: string): Promise<ReportView> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readReport(client, reportId)
    if (!row) throw new NotFoundError('Safety report not found.')
    return reportView(client, row, context)
  })
}

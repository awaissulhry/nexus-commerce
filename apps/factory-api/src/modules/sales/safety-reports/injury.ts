import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SAFETY_INJURY } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { eraseReasonProblems, injuryKeyOf, injuryProblems, SAFETY_INJURY_RECORD, SAFETY_REPORT_RECORD } from '@nexus/factory-domain/sales/safety-reports/rules'
import { command, type CommandCaller } from '../../../core/command'
import { blank, refuse } from '../service/open'
import { held, INJURY_WORDS, officeReport } from './access'
import { lockReport, touchReport } from './store'
import { reportRecordOf, type ReportView } from './view'

/**
 * Whether someone was hurt, and in what words (B-W2b-351; SAL-415; GDPR art. 9): the ONLY reads and writes of
 * ProductSafetyInjury after the intake, for the product-safety role (sales.safety.injury over the report). As the protected reads
 * of B-W2b-125: an opening is a command that records the view first (a ProtectedView PRODUCT_SAFETY_INJURY row and an audit row
 * on the report, `safetyReports.injuryOpened`, never the words; B-W2b-399), and the words are read AFTER that command
 * commits and returned as they stand (a command's answer is kept in its receipt, so the words never enter one). No list, export,
 * mail, search entry, thread or audit row ever carries them.
 *
 *   POST /sales/safety-reports/:id/injury/open    whether someone was hurt, the consent's time, the words (or that they were
 *                                                 erased, when and by whom)
 *   POST /sales/safety-reports/:id/injury         the report did not say (a mail that did not): record it once
 *   POST /sales/safety-reports/:id/injury/erase   on request (GDPR art. 17): the words blanked with when and by whom, never back
 */

/** POST /sales/safety-reports/:reportId/injury/open */
export async function openInjury(caller: CommandCaller, reportId: string, idempotencyKey?: string) {
  const { context, row } = await officeReport(caller, reportId, SALES_SAFETY_INJURY, INJURY_WORDS)
  const found = await caller.withClient((client) => client.productSafetyInjury.findFirst({ where: { reportId: row.id }, select: { id: true } }))
  if (!found) throw held('NO_INJURY', row.number)
  await command(caller, { name: 'safetyReports.injuryOpened', idempotencyKey, input: { reportId: row.id } }, async (tools) => {
    // B-W2b-399 (AU1:01): the view log of protected data (B-W2b-375's PRODUCT_SAFETY_INJURY: the injury's company, nobody of
    // the company's own staff named), written first, in the same command as the audit row.
    await tools.tx.protectedView.createMany({ data: [{ id: newId(), companyId: row.companyId, recordType: 'PRODUCT_SAFETY_INJURY', recordId: found.id, employeeId: null, what: 'OPEN', viewerId: context.actorId, viewedAt: tools.now }] })
    tools.audit({ action: 'safetyReports.injuryOpened', recordType: SAFETY_REPORT_RECORD, recordId: row.id, companyId: row.companyId, after: { what: 'OPEN' } })
    return { opened: true }
  })
  const injury = await caller.withClient((client) =>
    client.productSafetyInjury.findUniqueOrThrow({ where: { id: found.id }, select: { injured: true, consentAt: true, injuryWords: true, erasedAt: true, erasedById: true, createdAt: true, createdById: true } }),
  )
  return {
    injury: {
      reportId: row.id,
      number: row.number,
      injured: injury.injured,
      consentAt: injury.consentAt ? toUtcIso(injury.consentAt) : null,
      words: injury.injuryWords,
      erased: injury.erasedAt ? { at: toUtcIso(injury.erasedAt), byId: injury.erasedById } : null,
      recordedAt: toUtcIso(injury.createdAt),
      recordedById: injury.createdById,
    },
  }
}

/** POST /sales/safety-reports/:reportId/injury {version, injured, consent?, words?} — once, when the report did not say. */
export async function recordInjury(caller: CommandCaller, reportId: string, body: { readonly version: number; readonly injured: boolean; readonly consent?: boolean | undefined; readonly words?: string | null | undefined }, idempotencyKey?: string): Promise<{ report: ReportView }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_INJURY, INJURY_WORDS)
  // The intake's own rules for the injury's words.
  const problems = injuryProblems({ injured: body.injured, injuryConsent: body.consent ?? false, injuryWords: body.words ?? null })
  if (problems.length > 0) refuse(problems.map((issue) => ({ ...issue, path: issue.path === 'body/injuryConsent' ? 'body/consent' : issue.path === 'body/injuryWords' ? 'body/words' : issue.path })), 'Whether someone was hurt cannot be recorded like this.')
  // The input is only hashed into the receipt; the words never enter an answer, an audit row or an event.
  await command(caller, { name: 'safetyReports.recordInjury', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version, { closedToo: true })
    if (await tools.tx.productSafetyInjury.findFirst({ where: { reportId: row.id }, select: { id: true } })) throw held('INJURY_RECORDED', row.number)
    const id = newId()
    const words = body.injured && body.consent === true ? blank(body.words) : null
    await tools.tx.productSafetyInjury.create({
      data: { id, companyId: row.companyId, reportId: row.id, key: injuryKeyOf(row.id), injured: body.injured, consentAt: body.injured && body.consent === true ? tools.now : null, injuryWords: words, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
      select: { id: true },
    })
    await touchReport(tools, row)
    tools.audit({ action: 'safetyReports.injuryRecorded', recordType: SAFETY_INJURY_RECORD, recordId: id, companyId: row.companyId, after: { reportId: row.id, recorded: true } })
    tools.emit({ type: 'safety_report.changed', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, fields: ['injury'] } })
    return null
  })
  return { report: await reportRecordOf(caller, seen.id) }
}

/** POST /sales/safety-reports/:reportId/injury/erase {version, reason} — the words blanked in ONE update with when and by whom. */
export async function eraseInjury(caller: CommandCaller, reportId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ report: ReportView }> {
  const { context, row: seen } = await officeReport(caller, reportId, SALES_SAFETY_INJURY, INJURY_WORDS)
  const problems = eraseReasonProblems(body.reason)
  if (problems.length > 0) refuse(problems, 'The erasure needs its reason.')
  await command(caller, { name: 'safetyReports.eraseInjury', idempotencyKey, input: { reportId, ...body } }, async (tools) => {
    const row = await lockReport(tools, seen.id, body.version, { closedToo: true })
    const injury = await tools.tx.productSafetyInjury.findFirst({ where: { reportId: row.id }, select: { id: true, erasedAt: true } })
    if (!injury) throw held('NO_INJURY', row.number)
    if (injury.erasedAt) throw held('ERASED', row.number)
    if ((await tools.tx.productSafetyInjury.count({ where: { id: injury.id, injuryWords: { not: null } } })) === 0) throw held('NO_WORDS', row.number)
    const { count } = await tools.tx.productSafetyInjury.updateMany({ where: { id: injury.id, erasedAt: null }, data: { injuryWords: null, erasedAt: tools.now, erasedById: context.actorId, updatedAt: tools.now, version: { increment: 1 } } })
    if (count !== 1) throw new NotFoundError('Safety report not found.')
    await touchReport(tools, row)
    tools.audit({ action: 'safetyReports.eraseInjury', recordType: SAFETY_INJURY_RECORD, recordId: injury.id, companyId: row.companyId, before: { words: 'set' }, after: { reportId: row.id, words: null, erasedById: context.actorId }, reason: body.reason.trim() })
    tools.emit({ type: 'safety_report.erased', subject: row.id, companyId: row.companyId, payload: { reportId: row.id, number: row.number, what: 'INJURY_WORDS' } })
    return null
  })
  return { report: await reportRecordOf(caller, seen.id) }
}

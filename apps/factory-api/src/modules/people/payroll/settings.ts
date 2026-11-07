import { ConflictError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_VIEW } from '@nexus/factory-domain/people/payroll/permissions'
import { CONSULTANT_PROBLEM_WORDS, consultantProblemOf, payrollCodeOf, payrollCodeProblems, PRINTER_PROBLEM_WORDS, printerProblemOf, type PayrollSettingsRefusal } from '@nexus/factory-domain/people/payroll/settings'
import { command, type CommandCaller } from '../../../core/command'
import type { Client } from '../attendance/store'
import { companyFor, reachesCompany } from '../close/store'
import { officeOf, refuse } from '../employees/access'

/**
 * People settings › Payroll and statements (B-W2b-89; follow-ups of B-W2b-54 and B-W2b-68; design people.settings): the
 * company's labour consultant as a party (PeopleSettings.payrollConsultantPartyId), the payroll code their software knows the
 * company by (Company.payrollCode, which the file's company column prints) and the office printer of the worker statements
 * (PeopleSettings.statementPrinterId, read by My day's print). Settings, not a person's data: no legal gate.
 *
 *   GET /people/payroll/settings?companyId   people.payroll.view over every site of the company: the three, what to choose
 *                                            from, and whether a named one still serves (in words)
 *   PUT /people/payroll/settings             people.payroll.manage over every site of it: the three, the version read
 *
 * A consultant or printer is checked when it is named (409 `refusal/NOT_CONSULTANT` | `refusal/PRINTER_NOT_USABLE` at the
 * field), as the database does: one blocked or archived later stays named, the read says so, and an edit of the other fields
 * still goes. The version is the People settings row's, shared with the other cards of the page.
 */

const PARTY = { id: true, code: true, legalName: true, tradeName: true, companyId: true, roles: true, status: true } as const
const PRINTER = { id: true, code: true, name: true, kind: true, status: true, site: { select: { id: true, code: true, name: true } } } as const

type PartyRow = { id: string; code: string; legalName: string; tradeName: string | null; companyId: string | null; roles: string[]; status: string }

async function emailsOf(db: Client, partyIds: readonly string[]): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map()
  const contacts = await db.partyContact.findMany({ where: { partyId: { in: [...partyIds] }, status: 'ACTIVE', email: { not: null } }, select: { partyId: true, email: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string>()
  for (const contact of contacts) if (contact.email && !out.has(contact.partyId)) out.set(contact.partyId, contact.email)
  return out
}

const partyName = (party: PartyRow): string => party.tradeName ?? party.legalName

const refuseSetting = (code: PayrollSettingsRefusal, message: string, field: string): never => refuse(code, message, field)

/** The company's labour consultant as the payroll reads it (the Send's recipient by default); null: none named. */
export async function consultantOf(db: Client, companyId: string) {
  const settings = await db.peopleSettings.findUnique({ where: { id: companyId }, select: { payrollConsultantPartyId: true } })
  const id = settings?.payrollConsultantPartyId ?? null
  if (!id) return null
  const party = (await db.party.findUnique({ where: { id }, select: PARTY })) as PartyRow | null
  const problem = consultantProblemOf(party, companyId)
  const email = party ? ((await emailsOf(db, [party.id])).get(party.id) ?? null) : null
  return { partyId: id, code: party?.code ?? null, name: party ? partyName(party) : null, email, problem, words: problem ? CONSULTANT_PROBLEM_WORDS[problem] : null }
}

async function settingsView(db: Client, companyId: string, canManage: boolean) {
  const company = (await db.company.findUnique({ where: { id: companyId }, select: { code: true, legalName: true, payrollCode: true } }))!
  const settings = await db.peopleSettings.findUnique({ where: { id: companyId }, select: { statementPrinterId: true, version: true } })
  const consultant = await consultantOf(db, companyId)
  const printerId = settings?.statementPrinterId ?? null
  const printer = printerId ? await db.printer.findUnique({ where: { id: printerId }, select: PRINTER }) : null
  const printerProblem = printerId ? printerProblemOf(printer) : null
  const parties = (await db.party.findMany({ where: { roles: { has: 'CONSULTANT' }, status: 'ACTIVE', OR: [{ companyId }, { companyId: null }] }, select: PARTY, orderBy: [{ legalName: 'asc' }, { id: 'asc' }], take: 100 })) as PartyRow[]
  const emails = await emailsOf(db, parties.map((party) => party.id))
  const printers = await db.printer.findMany({ where: { companyId, kind: 'A4_PDF', status: 'ACTIVE' }, select: PRINTER, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 100 })
  return {
    companyId,
    version: settings?.version ?? null,
    company: { code: company.code, legalName: company.legalName },
    payrollCode: company.payrollCode,
    consultant,
    statementPrinter: printerId ? { id: printerId, code: printer?.code ?? null, name: printer?.name ?? null, site: printer?.site ?? null, problem: printerProblem, words: printerProblem ? PRINTER_PROBLEM_WORDS[printerProblem] : null } : null,
    choices: {
      consultants: parties.map((party) => ({ id: party.id, code: party.code, name: partyName(party), email: emails.get(party.id) ?? null, companyWide: party.companyId === null })),
      printers: printers.map((row) => ({ id: row.id, code: row.code, name: row.name, site: row.site })),
    },
    canManage,
    words: [
      company.payrollCode ? `The payroll file names the company ${company.payrollCode}.` : `No payroll code given: the payroll file names the company by its code, ${company.code}.`,
      printerId ? (printerProblem ? PRINTER_PROBLEM_WORDS[printerProblem] : 'Statements print on the printer named here.') : "No printer named: a statement prints on the site's only A4 printer, and is held where a site has several.",
    ],
  }
}

/** GET /people/payroll/settings. */
export async function readPayrollSettings(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const place = await companyFor(db, context, query.companyId, [PEOPLE_PAYROLL_VIEW, PEOPLE_PAYROLL_MANAGE])
    return settingsView(db, place.company.id, reachesCompany(context, place, [PEOPLE_PAYROLL_MANAGE]))
  })
}

interface SaveBody {
  readonly companyId: string
  readonly version: number | null
  readonly consultantPartyId: string | null
  readonly payrollCode: string | null
  readonly statementPrinterId: string | null
}

const manageWords = 'The payroll settings are kept by a role with people.payroll.manage over every site of the company.'

/** PUT /people/payroll/settings: the three, with the version read (null: the company has no People settings yet). */
export async function savePayrollSettings(caller: CommandCaller, body: SaveBody, key?: string) {
  const context = officeOf(caller)
  const payrollCode = payrollCodeOf(body.payrollCode)
  const problems = payrollCodeProblems(payrollCode)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await caller.withClient(async (db) => {
    const place = await companyFor(db, context, body.companyId, [PEOPLE_PAYROLL_VIEW, PEOPLE_PAYROLL_MANAGE])
    if (!reachesCompany(context, place, [PEOPLE_PAYROLL_MANAGE])) throw new ForbiddenError(manageWords)
  })
  const { result } = await command(caller, { name: 'people.changePayrollSettings', idempotencyKey: key, input: body }, async (tools) => {
    const { tx } = tools
    const row = await tx.peopleSettings.findUnique({ where: { id: body.companyId }, select: { payrollConsultantPartyId: true, statementPrinterId: true, version: true } })
    const version = row?.version ?? null
    if (version !== body.version) throw new ConflictError(version === null ? 'This company has no People settings yet: send version null.' : `The People settings changed since you read them (version ${version}, not ${String(body.version)}): read them again.`)
    const company = (await tx.company.findUnique({ where: { id: body.companyId }, select: { payrollCode: true } }))!
    const before = { consultantPartyId: row?.payrollConsultantPartyId ?? null, payrollCode: company.payrollCode, statementPrinterId: row?.statementPrinterId ?? null }
    const changed = [
      ...(before.consultantPartyId !== body.consultantPartyId ? (['CONSULTANT'] as const) : []),
      ...(before.payrollCode !== payrollCode ? (['PAYROLL_CODE'] as const) : []),
      ...(before.statementPrinterId !== body.statementPrinterId ? (['STATEMENT_PRINTER'] as const) : []),
    ]
    if (changed.length === 0) return settingsView(tx, body.companyId, true)
    if (changed.includes('CONSULTANT') && body.consultantPartyId) {
      const party = (await tx.party.findUnique({ where: { id: body.consultantPartyId }, select: PARTY })) as PartyRow | null
      const problem = consultantProblemOf(party, body.companyId)
      if (problem) refuseSetting('NOT_CONSULTANT', problem === 'GONE' ? 'That party is not found.' : 'The labour consultant is an active party with the Consultant role, of this company or of every company.', 'consultantPartyId')
    }
    if (changed.includes('STATEMENT_PRINTER') && body.statementPrinterId) {
      const printer = await tx.printer.findFirst({ where: { id: body.statementPrinterId, companyId: body.companyId }, select: { kind: true, status: true } })
      if (printerProblemOf(printer)) refuseSetting('PRINTER_NOT_USABLE', 'Statements print on an active A4 printer of this company.', 'statementPrinterId')
    }
    const data = { payrollConsultantPartyId: body.consultantPartyId, statementPrinterId: body.statementPrinterId }
    const newVersion = row
      ? (await tx.peopleSettings.update({ where: { id: body.companyId }, data: { ...data, version: { increment: 1 } }, select: { version: true } })).version
      : (await tx.peopleSettings.create({ data: { id: body.companyId, companyId: body.companyId, ...data, createdById: context.actorId }, select: { version: true } })).version
    if (changed.includes('PAYROLL_CODE')) {
      await tx.company.update({ where: { id: body.companyId }, data: { payrollCode, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'Company', recordId: body.companyId, companyId: body.companyId, before: { payrollCode: before.payrollCode }, after: { payrollCode } })
    }
    tools.audit({ recordType: 'PeopleSettings', recordId: body.companyId, companyId: body.companyId, before: { payroll: before }, after: { payroll: { consultantPartyId: body.consultantPartyId, payrollCode, statementPrinterId: body.statementPrinterId }, changed } })
    tools.emit({ type: 'people_settings.payroll_changed', subject: body.companyId, companyId: body.companyId, payload: { companyId: body.companyId, version: newVersion, changed: [...changed] } })
    return settingsView(tx, body.companyId, true)
  })
  return result
}

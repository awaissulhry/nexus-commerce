import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { INVOICES_TAX_SWITCH } from '@nexus/factory-domain/invoicing/tax-codes/permissions'
import { switchWords, TAX_SWITCHES, type TaxSwitches } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'
import { assertCompany, readSwitches, refused, refusingInWords } from './store'

/**
 * A company's tax switches (B-W2b-392; GATE-ACCOUNTANT, lead decision 11-13; factory-db CompanyEInvoiceSettings, one row
 * per company, id = the company's): its tax codes on invoices, stamp duty charged to the customer and counted per quarter,
 * declarations of intent on invoices. All OFF until the accountant confirms; while off every answer says in words what
 * waits. Switching is invoices.tax.switch with a fresh step-up, ONE command that makes the row the first time (B-W2b-401
 * keeps the test mode and the self-invoice switch on the same row), audited, with `tax_settings.changed`.
 */

async function companyView(db: Reader, company: { id: string; code: string; legalName: string }) {
  const row = await readSwitches(db, company.id)
  const switches: TaxSwitches = { taxCodesOn: row.taxCodesOn, stampDutyOn: row.stampDutyOn, declarationsOfIntentOn: row.declarationsOfIntentOn }
  return { companyId: company.id, code: company.code, legalName: company.legalName, version: row.version, switches, selfInvoicesOn: row.selfInvoicesOn, words: switchWords(switches) }
}

/** invoices.view: the switches of every company the caller sees invoices of. */
export async function taxSettings(caller: CommandCaller) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const where = scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput
    const companies = await client.company.findMany({ where, select: { id: true, code: true, legalName: true }, orderBy: { code: 'asc' } })
    const views = []
    for (const company of companies) views.push(await companyView(client, company))
    return { companies: views }
  })
}

export interface PutTaxSettingsInput {
  readonly version?: number | undefined
  readonly taxCodesOn?: boolean | undefined
  readonly stampDutyOn?: boolean | undefined
  readonly declarationsOfIntentOn?: boolean | undefined
}

/** invoices.tax.switch (step-up): switches a company's tax duties on or off. Nothing changed: no command. */
export async function putTaxSettings(caller: CommandCaller, companyId: string, body: PutTaxSettingsInput, idempotencyKey: string | undefined, stepUp: () => void) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_SWITCH, { companyId }, 'Company')
  stepUp()
  const company = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true } }))
  if (!company) throw new NotFoundError('Company not found.')
  const before = await caller.withClient((client) => readSwitches(client, companyId))
  const wanted = Object.fromEntries(TAX_SWITCHES.map((name) => [name, body[name] ?? before[name]])) as Record<(typeof TAX_SWITCHES)[number], boolean>
  if (TAX_SWITCHES.every((name) => wanted[name] === before[name])) return { company: await caller.withClient((client) => companyView(client, company)) }
  if (before.version !== null && body.version !== undefined && body.version !== before.version) {
    throw refused('DATABASE', `The tax switches were changed meanwhile (version ${before.version}): read them again.`)
  }
  return refusingInWords(async () => {
    const { result } = await command(
      caller,
      { name: 'invoices.switchTax', idempotencyKey, input: { companyId, ...body }, ...(before.version === null ? {} : { record: { type: 'CompanyEInvoiceSettings' as const, id: companyId, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } }) },
      async (tools) => {
        if (before.version === null) {
          await tools.tx.companyEInvoiceSettings.create({ data: { id: companyId, companyId, ...wanted, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
        } else {
          await tools.tx.companyEInvoiceSettings.update({ where: { id: companyId }, data: wanted, select: { id: true } })
        }
        const changed = TAX_SWITCHES.filter((name) => wanted[name] !== before[name])
        tools.audit({
          recordType: 'CompanyEInvoiceSettings',
          recordId: companyId,
          companyId,
          before: Object.fromEntries(changed.map((name) => [name, before[name]])),
          after: Object.fromEntries(changed.map((name) => [name, wanted[name]])),
        })
        tools.emit({ type: 'tax_settings.changed', subject: companyId, companyId, payload: { companyId, ...wanted } })
        return { company: await companyView(tools.tx, company) }
      },
    )
    return result
  })
}

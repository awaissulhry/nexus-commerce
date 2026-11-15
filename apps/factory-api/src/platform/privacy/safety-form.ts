import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { PRIVACY_MANAGE, PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import { command, type CommandCaller } from '../../core/command'
import { companyFor } from './access'
import { noticeInForce } from './read'

/**
 * The outside doors of product-safety reports, per company (B-W2b-405; PV1:04; GATE-PRIVACY; replaces B-W2b-351's environment
 * variable FACTORY_SAFETY_REPORTS_OUTSIDE): the public DoC page's "Report a problem" and the portal's "Report a safety incident"
 * take reports for a company only while its switch is on (SalesSettings.safetyReportFormOn on the company's own row), which the
 * database allows only while the company's safety-report notice (PrivacyNoticeKind SAFETY_REPORT) is PUBLISHED. OFF by default;
 * switching on asks a fresh code (it opens a door to the public); off never does.
 *
 *   GET /privacy/safety-report-form?companyId=   the switch, the notice, and whether it may be switched on (privacy.view)
 *   PUT /privacy/safety-report-form              {companyId, on} (privacy.manage)
 *
 * The switch lives on the company's own sales settings: a company that has none yet saves them first (Sales › Settings), so the
 * group's quote rules it follows never change by themselves.
 */

export const SAFETY_FORM_HELD = Object.freeze({
  NO_NOTICE: "Publish the company's safety-report privacy notice first (Admin › Privacy & notices › Safety reports): the doors open only once it is published.",
  NO_SETTINGS: 'Save the company\'s own sales settings first (Sales › Settings, for this company): the switch is kept there, and the group\'s settings it follows never change by themselves.',
})

const formView = output({
  company: output({ id: id(), code: z.string(), name: z.string() }),
  on: z.boolean(),
  notice: output({ id: id(), label: z.string() }).nullable(),
  mayTurnOn: z.boolean(),
  held: output({ code: z.enum(['NO_NOTICE', 'NO_SETTINGS']), words: z.string() }).nullable(),
})
export const safetyFormContract = defineContract({ querystring: input({ companyId: id() }), response: { 200: formView } })
export const setSafetyFormContract = defineContract({ body: input({ companyId: id(), on: z.boolean() }), response: { 200: formView } })

export async function readSafetyForm(caller: CommandCaller, companyId: string) {
  const { company } = await companyFor(caller, companyId, PRIVACY_VIEW)
  return caller.withClient(async (client) => {
    const notice = await noticeInForce(client, company.id, 'SAFETY_REPORT')
    const settings = await client.salesSettings.findUnique({ where: { id: company.id }, select: { id: true, companyId: true, safetyReportFormOn: true } })
    const own = settings !== null && settings.companyId === company.id
    const held: keyof typeof SAFETY_FORM_HELD | null = notice === null ? 'NO_NOTICE' : !own ? 'NO_SETTINGS' : null
    return {
      company,
      on: own && settings.safetyReportFormOn,
      notice: notice ? { id: notice.id, label: notice.label } : null,
      mayTurnOn: held === null,
      held: held === null ? null : { code: held, words: SAFETY_FORM_HELD[held] },
    }
  })
}

export async function setSafetyForm(caller: CommandCaller, body: { readonly companyId: string; readonly on: boolean }, writes: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined }) {
  const { company } = await companyFor(caller, body.companyId, PRIVACY_MANAGE)
  const state = await readSafetyForm(caller, company.id)
  if (state.on === body.on) return state
  if (body.on && state.held) throw new InvalidStateError(state.held.words)
  if (body.on) writes.stepUp()
  await command(caller, { name: 'privacy.safetyReportForm', idempotencyKey: writes.idempotencyKey, input: body, record: { type: 'SalesSettings', id: company.id } }, async (tools) => {
    // The database refuses ON without the company's published safety-report notice, and on the group's row.
    await tools.tx.salesSettings.update({ where: { id: company.id }, data: { safetyReportFormOn: body.on, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'SalesSettings', recordId: company.id, companyId: company.id, before: { safetyReportFormOn: !body.on }, after: { safetyReportFormOn: body.on } })
    tools.emit({ type: 'privacy.safety_report_form_switched', subject: company.id, companyId: company.id, payload: { companyId: company.id, on: body.on } })
    return null
  })
  return readSafetyForm(caller, company.id)
}

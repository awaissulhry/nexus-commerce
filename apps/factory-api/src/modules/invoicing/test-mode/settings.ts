import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { depthRuleWords, SELF_INVOICE_RULE } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { INVOICES_TAX_SWITCH } from '@nexus/factory-domain/invoicing/tax-codes/permissions'
import { INVOICES_TEST_MODE_MANAGE } from '@nexus/factory-domain/invoicing/test-mode/permissions'
import { goLiveProblems, goLiveWords, SIMULATED_OUTCOME_WORDS, SIMULATED_OUTCOMES, TEST_REF_PREFIX, testModeState, type SimulatedOutcome } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { SdiRuntime } from '../sdi/runtime'
import { officeContextOf, type Reader } from '../store'
import { assertCompany } from '../tax-codes/store'
import { refusedDepth, refusingDepth } from './refusals'
import { connectionsOf, instantOf, readSettings, type EInvoiceSettings } from './store'

/**
 * A company's e-invoicing settings (B-W2b-401; FIN-096; design finance.settings "E-invoicing (SDI)", the pop-up "Leave e-invoice
 * test mode?"; the banner of every invoice page): where it stands (test mode or live since when, who answers its sends), what
 * stops it going live, the answer test mode simulates, and the step's switch for self-invoices, debit notes and the VAT time
 * limit (GATE-ACCOUNTANT, OFF by default). Reads are invoices.view per company the caller sees invoices of. Leaving test mode,
 * going back to it and picking the simulated answer are invoices.testMode.manage with a fresh step-up; the switch is B-W2b-392's
 * invoices.tax.switch with a fresh step-up. Each write is ONE command on the company's row (made the first time), audited, with
 * e_invoicing.settings_changed.
 */

async function companyView(db: Reader, runtime: Pick<SdiRuntime, 'liveProviderReady'>, company: { id: string; code: string; legalName: string }, caller: { manage: boolean; switchRules: boolean }) {
  const settings = await readSettings(db, company.id)
  const accounts = await connectionsOf(db, company.id)
  const single = accounts.length === 1 ? accounts[0]! : null
  const state = testModeState({ testMode: settings.testMode, liveSince: instantOf(settings.liveSince), simulateOutcome: settings.simulateOutcome, connection: single })
  const problems = goLiveProblems({ testMode: settings.testMode, connections: accounts, liveProviderReady: runtime.liveProviderReady })
  const testSent = await db.sdiSubmission.count({ where: { invoice: { companyId: company.id }, providerRef: { startsWith: TEST_REF_PREFIX } } })
  return {
    companyId: company.id,
    code: company.code,
    legalName: company.legalName,
    version: settings.version,
    testMode: settings.testMode,
    liveSince: instantOf(settings.liveSince),
    liveSetById: settings.liveSetById,
    simulateOutcome: settings.simulateOutcome,
    state,
    connection: {
      state: accounts.length === 0 ? ('NONE' as const) : accounts.length > 1 ? ('SEVERAL' as const) : single!.status === 'PAUSED' ? ('PAUSED' as const) : ('ACTIVE' as const),
      accounts: accounts.map((account) => ({ id: account.id, label: account.label, mode: account.mode, status: account.status })),
    },
    goLive: { allowed: problems.length === 0, problems, words: goLiveWords(testSent) },
    testSent,
    simulateOptions: SIMULATED_OUTCOMES.map((outcome) => ({ outcome, words: SIMULATED_OUTCOME_WORDS[outcome] })),
    rules: { selfInvoicesOn: settings.selfInvoicesOn, words: depthRuleWords(settings.selfInvoicesOn), rule: SELF_INVOICE_RULE },
    can: caller,
  }
}

/** invoices.view: the e-invoicing settings of every company the caller sees invoices of. */
export async function eInvoicingSettings(runtime: Pick<SdiRuntime, 'liveProviderReady'>, callerOf: CommandCaller) {
  const context = officeContextOf(callerOf)
  const actor = actorOf(context)
  return callerOf.withClient(async (client) => {
    const where = scopeWhere(actor, INVOICES_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput
    const companies = await client.company.findMany({ where, select: { id: true, code: true, legalName: true }, orderBy: { code: 'asc' } })
    const views = []
    for (const company of companies) {
      views.push(await companyView(client, runtime, company, { manage: can(actor, INVOICES_TEST_MODE_MANAGE, { companyId: company.id }), switchRules: can(actor, INVOICES_TAX_SWITCH, { companyId: company.id }) }))
    }
    return { companies: views }
  })
}

type Change = { readonly testMode?: boolean | undefined; readonly simulateOutcome?: SimulatedOutcome | undefined; readonly selfInvoicesOn?: boolean | undefined }

/** Writes the company's row (made the first time) inside the command, audited, with its event. */
async function writeSettings(tools: CommandTools, companyId: string, before: EInvoiceSettings, change: Change, action: 'WENT_LIVE' | 'BACK_TO_TEST' | 'SIMULATE' | 'SWITCH'): Promise<void> {
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const data: Prisma.CompanyEInvoiceSettingsUncheckedUpdateInput = {
    ...(change.testMode === false && before.testMode ? { testMode: false, liveSince: tools.now, liveSetById: actorId } : {}),
    ...(change.testMode === true && !before.testMode ? { testMode: true, liveSince: null, liveSetById: null } : {}),
    ...(change.simulateOutcome !== undefined ? { simulateOutcome: change.simulateOutcome } : {}),
    ...(change.selfInvoicesOn !== undefined ? { selfInvoicesOn: change.selfInvoicesOn } : {}),
  }
  if (before.version === null) {
    await tools.tx.companyEInvoiceSettings.create({ data: { ...(data as Omit<Prisma.CompanyEInvoiceSettingsUncheckedCreateInput, 'id' | 'companyId'>), id: companyId, companyId, createdById: actorId }, select: { id: true } })
  } else {
    await tools.tx.companyEInvoiceSettings.update({ where: { id: companyId }, data, select: { id: true } })
  }
  const after = await readSettings(tools.tx, companyId)
  tools.audit({
    recordType: 'CompanyEInvoiceSettings',
    recordId: companyId,
    companyId,
    before: { testMode: before.testMode, liveSince: instantOf(before.liveSince), simulateOutcome: before.simulateOutcome, selfInvoicesOn: before.selfInvoicesOn },
    after: { testMode: after.testMode, liveSince: instantOf(after.liveSince), simulateOutcome: after.simulateOutcome, selfInvoicesOn: after.selfInvoicesOn, action },
  })
  tools.emit({ type: 'e_invoicing.settings_changed', subject: companyId, companyId, payload: { companyId, action, testMode: after.testMode, simulateOutcome: after.simulateOutcome, selfInvoicesOn: after.selfInvoicesOn } })
}

async function companyOf(caller: CommandCaller, companyId: string) {
  const company = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true } }))
  if (!company) throw new NotFoundError('Company not found.')
  return company
}

const recordOf = (before: EInvoiceSettings, companyId: string, version: number | undefined) =>
  before.version === null ? {} : { record: { type: 'CompanyEInvoiceSettings' as const, id: companyId, ...(version === undefined ? {} : { expectedVersion: version }) } }

export interface PutTestModeInput {
  readonly version?: number | undefined
  readonly testMode?: boolean | undefined
  readonly simulateOutcome?: SimulatedOutcome | undefined
}

/**
 * invoices.testMode.manage (step-up): leaves test mode (testMode false: problems → 409 refusal/GO_LIVE in words), goes back
 * to it (testMode true), or picks the simulated answer. Nothing changed: no command.
 */
export async function putTestMode(runtime: Pick<SdiRuntime, 'liveProviderReady'>, caller: CommandCaller, companyId: string, body: PutTestModeInput, idempotencyKey: string | undefined, stepUp: () => void) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TEST_MODE_MANAGE, { companyId }, 'Company')
  stepUp()
  const company = await companyOf(caller, companyId)
  const before = await caller.withClient((client) => readSettings(client, companyId))
  const goesLive = body.testMode === false && before.testMode
  const backToTest = body.testMode === true && !before.testMode
  const simulate = body.simulateOutcome !== undefined && body.simulateOutcome !== before.simulateOutcome
  const answer = async () => ({ company: await caller.withClient((client) => companyView(client, runtime, company, { manage: true, switchRules: can(actorOf(context), INVOICES_TAX_SWITCH, { companyId }) })) })
  if (!goesLive && !backToTest && !simulate) return answer()
  if (before.version !== null && body.version !== undefined && body.version !== before.version) throw refusedDepth('DATABASE', `The e-invoicing settings were changed meanwhile (version ${before.version}): read them again.`)
  if (goesLive) {
    const problems = goLiveProblems({ testMode: true, connections: await caller.withClient((client) => connectionsOf(client, companyId)), liveProviderReady: runtime.liveProviderReady })
    if (problems.length > 0) throw refusedDepth('GO_LIVE', problems.map((problem) => problem.message).join(' '))
  }
  await refusingDepth(() =>
    command(caller, { name: 'invoices.testMode', idempotencyKey, input: { companyId, ...body }, ...recordOf(before, companyId, body.version) }, async (tools) => {
      await writeSettings(tools, companyId, before, { ...(goesLive || backToTest ? { testMode: body.testMode } : {}), ...(simulate ? { simulateOutcome: body.simulateOutcome } : {}) }, goesLive ? 'WENT_LIVE' : backToTest ? 'BACK_TO_TEST' : 'SIMULATE')
      return { done: true }
    }),
  )
  return answer()
}

/** invoices.tax.switch (step-up): the step's switch (self-invoices, debit notes, the VAT time limit), OFF until the accountant confirms. */
export async function putDepthRules(runtime: Pick<SdiRuntime, 'liveProviderReady'>, caller: CommandCaller, companyId: string, body: { readonly version?: number | undefined; readonly selfInvoicesOn: boolean }, idempotencyKey: string | undefined, stepUp: () => void) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, INVOICES_TAX_SWITCH, { companyId }, 'Company')
  stepUp()
  const company = await companyOf(caller, companyId)
  const before = await caller.withClient((client) => readSettings(client, companyId))
  const answer = async () => ({ company: await caller.withClient((client) => companyView(client, runtime, company, { manage: can(actorOf(context), INVOICES_TEST_MODE_MANAGE, { companyId }), switchRules: true })) })
  if (body.selfInvoicesOn === before.selfInvoicesOn) return answer()
  if (before.version !== null && body.version !== undefined && body.version !== before.version) throw refusedDepth('DATABASE', `The e-invoicing settings were changed meanwhile (version ${before.version}): read them again.`)
  await refusingDepth(() =>
    command(caller, { name: 'invoices.switchSelfInvoices', idempotencyKey, input: { companyId, ...body }, ...recordOf(before, companyId, body.version) }, async (tools) => {
      await writeSettings(tools, companyId, before, { selfInvoicesOn: body.selfInvoicesOn }, 'SWITCH')
      return { done: true }
    }),
  )
  return answer()
}

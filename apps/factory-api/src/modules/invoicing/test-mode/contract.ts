import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DEPTH_RULES } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { GO_LIVE_PROBLEMS, SIMULATED_OUTCOMES } from '@nexus/factory-domain/invoicing/test-mode/test-mode'

/**
 * The contracts of a company's e-invoicing settings (B-W2b-401; FIN-096): test mode, the simulated answer, the step's switch
 * (self-invoices, debit notes, the VAT time limit). Answers carry codes and the words built from them. A version is the
 * edit-conflict guard.
 */

const version = z.number().int().min(1)
const companyParams = input({ companyId: id() })
const ruleView = output({ status: z.literal('UNVERIFIED'), words: z.string() })

// ---- settings (FIN-096) ---------------------------------------------------------------------------------------------------

const companySettings = output({
  companyId: id(),
  code: z.string(),
  legalName: z.string(),
  version: z.number().int().nullable(),
  testMode: z.boolean(),
  liveSince: instant().nullable(),
  liveSetById: id().nullable(),
  simulateOutcome: z.enum(SIMULATED_OUTCOMES),
  state: output({ code: z.enum(['TEST', 'LIVE']), banner: z.string().nullable(), words: z.string(), simulated: z.boolean() }),
  connection: output({ state: z.enum(['NONE', 'SEVERAL', 'PAUSED', 'ACTIVE']), accounts: z.array(output({ id: id(), label: z.string(), mode: z.string(), status: z.string() })) }),
  goLive: output({ allowed: z.boolean(), problems: z.array(output({ code: z.enum(GO_LIVE_PROBLEMS), message: z.string() })), words: z.string() }),
  /** Sends simulated in test mode (they never reached SDI). */
  testSent: z.number().int(),
  simulateOptions: z.array(output({ outcome: z.enum(SIMULATED_OUTCOMES), words: z.string() })),
  rules: output({ selfInvoicesOn: z.boolean(), words: z.record(z.enum(DEPTH_RULES), z.string()), rule: ruleView }),
  can: output({ manage: z.boolean(), switchRules: z.boolean() }),
})

export const eInvoicingSettingsContract = defineContract({ response: { 200: output({ companies: z.array(companySettings) }) } })

export const putTestModeContract = defineContract({
  params: companyParams,
  body: input({ version: version.optional(), testMode: z.boolean().optional(), simulateOutcome: z.enum(SIMULATED_OUTCOMES).optional() }),
  response: { 200: output({ company: companySettings }) },
})

export const putDepthRulesContract = defineContract({
  params: companyParams,
  body: input({ version: version.optional(), selfInvoicesOn: z.boolean() }),
  response: { 200: output({ company: companySettings }) },
})

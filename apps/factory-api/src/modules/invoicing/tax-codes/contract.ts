import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { MAX_LABEL, MAX_LEGAL_REF, TAX_CODE_STATES, TAX_CODE_STATUSES, TAX_CODE_VERIFICATIONS } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import { DECLARATION_STATES } from '@nexus/factory-domain/invoicing/intent/intent'
import { STAMP_DUTY_REASONS } from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The contracts of tax codes as data and the company's tax switches (B-W2b-392; FIN-107; GATE-ACCOUNTANT), and of an
 * invoice's tax view (what its tax codes, stamp duty and declaration of intent say before the issue). Answers carry codes
 * and the words built from them. A version is the edit-conflict guard.
 */

const version = z.number().int().min(1)
const companyQuery = input({ companyId: id() })
const codeParams = input({ taxCodeId: id() })
const country = z.string().trim().regex(/^[A-Z]{2}$/, { message: 'Two capitals (ISO 3166-1): IT.' })
const rate = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, { message: 'A rate in percent, 0 to 100, at most 2 decimals: "22", "0".' })
const text = (longest: number) => z.string().max(longest)

const ruleView = output({
  id: z.string(),
  law: z.string(),
  summary: z.string(),
  /** The catalogue's (factory-domain tax/rules.ts). */
  catalogueStatus: z.enum(TAX_CODE_VERIFICATIONS),
  /** For this company: read from its codes in force (ruleStatusFromCodes). */
  status: z.enum(TAX_CODE_VERIFICATIONS),
  accountantToConfirm: z.string().nullable(),
  /** Its codes in force today. */
  taxCodeIds: z.array(id()),
})

export const taxCodeView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  country: z.string(),
  code: z.string(),
  label: z.string(),
  ratePct: z.string(),
  natura: z.string().nullable(),
  legalRef: z.string().nullable(),
  accountCodeKey: z.string().nullable(),
  ruleId: z.string().nullable(),
  verification: z.enum(TAX_CODE_VERIFICATIONS),
  confirmedAt: z.string().nullable(),
  confirmedById: id().nullable(),
  validFrom: businessDate(),
  validTo: businessDate().nullable(),
  status: z.enum(TAX_CODE_STATUSES),
  /** On today (Europe/Rome). */
  state: z.enum(TAX_CODE_STATES),
  /** "22 %, in force from 2026-01-01, waiting for the accountant". */
  words: z.string(),
  can: output({ edit: z.boolean(), relabel: z.boolean(), end: z.boolean(), newVersion: z.boolean(), archive: z.boolean(), delete: z.boolean(), confirm: z.boolean() }),
})

const switchesView = output({ taxCodesOn: z.boolean(), stampDutyOn: z.boolean(), declarationsOfIntentOn: z.boolean() })

export const listTaxCodesContract = defineContract({
  querystring: companyQuery,
  response: {
    200: output({
      companyId: id(),
      today: businessDate(),
      switches: switchesView,
      /** What the tax-codes switch does now, or what waits for the accountant. */
      waits: z.string().nullable(),
      codes: z.array(taxCodeView),
      rules: z.array(ruleView),
    }),
  },
})

const codeBody = {
  label: text(MAX_LABEL),
  ratePct: rate,
  natura: z.string().trim().max(5).nullish(),
  legalRef: text(MAX_LEGAL_REF).nullish(),
  accountCodeKey: z.string().trim().max(60).nullish(),
  ruleId: z.string().trim().max(60).nullish(),
}

export const createTaxCodeContract = defineContract({
  body: input({ companyId: id(), country: country.optional(), code: z.string().trim().min(1).max(20), ...codeBody, validFrom: businessDate(), validTo: businessDate().nullish() }),
  response: { 201: output({ taxCode: taxCodeView }) },
})

export const updateTaxCodeContract = defineContract({
  params: codeParams,
  body: input({ version, label: codeBody.label.optional(), ratePct: rate.optional(), natura: codeBody.natura, legalRef: codeBody.legalRef, accountCodeKey: codeBody.accountCodeKey, ruleId: codeBody.ruleId, validFrom: businessDate().optional(), validTo: businessDate().nullish() }),
  response: { 200: output({ taxCode: taxCodeView }) },
})

export const newVersionContract = defineContract({
  params: codeParams,
  body: input({ version, validFrom: businessDate(), validTo: businessDate().nullish(), label: codeBody.label.optional(), ratePct: rate.optional(), natura: codeBody.natura, legalRef: codeBody.legalRef, accountCodeKey: codeBody.accountCodeKey, ruleId: codeBody.ruleId }),
  response: { 201: output({ ended: taxCodeView, taxCode: taxCodeView }) },
})

export const archiveTaxCodeContract = defineContract({ params: codeParams, body: input({ version }), response: { 200: output({ taxCode: taxCodeView }) } })

export const deleteTaxCodeContract = defineContract({
  params: codeParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: z.literal(true), id: id() }) },
})

export const confirmTaxCodeContract = defineContract({ params: codeParams, body: input({ version }), response: { 200: output({ taxCode: taxCodeView }) } })

// ---- the company's tax switches -------------------------------------------------------------------------------------

const companySwitches = output({
  companyId: id(),
  code: z.string(),
  legalName: z.string(),
  /** The settings row's version (null: no row yet, every switch off). */
  version: z.number().int().nullable(),
  switches: switchesView,
  /** B-W2b-401's switch, shown only. */
  selfInvoicesOn: z.boolean(),
  /** Per switch: what it does now, or what waits for the accountant. */
  words: output({ taxCodesOn: z.string(), stampDutyOn: z.string(), declarationsOfIntentOn: z.string() }),
})

export const taxSettingsContract = defineContract({ response: { 200: output({ companies: z.array(companySwitches) }) } })

export const putTaxSettingsContract = defineContract({
  params: input({ companyId: id() }),
  body: input({ version: version.optional(), taxCodesOn: z.boolean().optional(), stampDutyOn: z.boolean().optional(), declarationsOfIntentOn: z.boolean().optional() }),
  response: { 200: output({ company: companySwitches }) },
})

// ---- an invoice's tax view ------------------------------------------------------------------------------------------

const problem = output({ code: z.string(), path: z.string(), message: z.string() })

export const invoiceTaxContract = defineContract({
  params: input({ invoiceId: id() }),
  response: {
    200: output({
      invoiceId: id(),
      status: z.string(),
      switches: switchesView,
      stampDuty: output({
        amount: money.price(z.number().int().nullable()),
        charge: z.boolean(),
        reason: z.enum(STAMP_DUTY_REASONS),
        /** What the invoice charges now (its STAMP_DUTY line), or null. */
        chargedAmount: money.price(z.number().int().nullable()),
        words: z.string(),
      }),
      declarationOfIntent: output({
        id: id(),
        protocolNumber: z.string(),
        protocolDate: businessDate(),
        year: z.number().int(),
        state: z.enum(DECLARATION_STATES),
        amount: money.price(z.number().int()),
        usedAmount: money.price(z.number().int()),
        /** What this invoice would use of it (its N3.5 lines' net). */
        thisAmount: money.price(z.number().int()),
      }).nullable(),
      /** The customer's live declarations of the company this invoice could name (checked or not). */
      declarationCandidates: z.array(output({ id: id(), protocolNumber: z.string(), year: z.number().int(), state: z.enum(DECLARATION_STATES) })),
      /** The tax checks before issue (TAX_CODE, STAMP_DUTY, INTENT_*), the issue's own words. */
      problems: z.array(problem),
      /** What waits for the accountant (switches off), in words. */
      waits: z.array(z.string()),
    }),
  },
})

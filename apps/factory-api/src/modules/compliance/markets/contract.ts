import { z } from 'zod'
import { DOCUMENTS, LIST_MAX, MARKET_CODE_MAX, NAME_MAX, NOTE_MAX, REASON_MAX, RULES_MAX } from '@nexus/factory-domain/compliance/markets/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Market profiles (B-W2b-249; PRD-275; design compliance.settings › rm-markets, the LanguageMatrix). Codes, names,
 * languages, marks, national rules in words, needs and the switch with its reason. No price, no cost.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const words = z.record(z.string().min(2).max(12), z.string().trim().min(1).max(2000))
const codes = (max: number) => z.array(z.string().trim().min(1).max(max)).max(LIST_MAX)
const nationalRule = z.strictObject({
  key: z.string().trim().min(1).max(60),
  words,
  law: z.string().trim().min(1).max(300).optional(),
  href: z.string().trim().min(1).max(2000).optional(),
})

export const marketView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  /** null: every company's market. */
  companyId: id().nullable(),
  labelLanguages: z.array(z.string()),
  docLanguages: z.array(z.string()),
  userInfoLanguages: z.array(z.string()),
  markings: z.array(z.string()),
  nationalRules: z.array(output({ key: z.string(), words: z.record(z.string(), z.string()), law: z.string().nullable(), href: z.string().nullable() })),
  /** An importer or authorised representative in the market is needed. */
  importerNeeded: z.boolean(),
  gpsrContactNeeded: z.boolean(),
  seq: z.number().int(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: instant().nullable(),
  switchedBy: person,
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  updatedAt: instant(),
})
export type MarketView = z.infer<typeof marketView>

const matrix = output({
  languages: z.array(z.string()),
  markets: z.array(output({ code: z.string(), name: z.string(), switchedOn: z.boolean(), needs: z.array(output({ language: z.string(), documents: z.array(z.enum(DOCUMENTS)) })) })),
})

export const listMarketsContract = defineContract({
  querystring: input({ status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional() }),
  response: { 200: output({ markets: z.array(marketView), matrix, asOf: instant(), mayManage: z.boolean() }) },
})

export const languagesContract = defineContract({
  response: {
    200: output({
      matrix,
      /** Per language the switched-on markets need: how many ACTIVE phrases print in it (approved current words, or the source). */
      phrases: z.array(output({ language: z.string(), inLibrary: z.number().int(), ready: z.number().int(), proposed: z.number().int(), stale: z.number().int(), missing: z.number().int() })),
      asOf: instant(),
    }),
  },
})

const marketParams = input({ code: z.string().trim().min(2).max(MARKET_CODE_MAX) })
export const getMarketContract = defineContract({ params: marketParams, response: { 200: output({ market: marketView }) } })

const fields = {
  name: z.string().trim().min(1).max(NAME_MAX),
  nameI18n: words.nullable(),
  labelLanguages: codes(12),
  docLanguages: codes(12),
  userInfoLanguages: codes(12),
  markings: codes(20),
  nationalRules: z.array(nationalRule).max(RULES_MAX),
  importerNeeded: z.boolean(),
  gpsrContactNeeded: z.boolean(),
  seq: z.number().int().min(0).max(100_000),
  note: z.string().trim().min(1).max(NOTE_MAX).nullable(),
}

export const createMarketContract = defineContract({
  body: input({
    code: z.string().trim().min(2).max(MARKET_CODE_MAX),
    /** Leave it out for a market of every company; a company's own market needs the permission over that company. */
    companyId: id().nullable().optional(),
    name: fields.name,
    nameI18n: fields.nameI18n.optional(),
    labelLanguages: fields.labelLanguages.optional(),
    docLanguages: fields.docLanguages.optional(),
    userInfoLanguages: fields.userInfoLanguages.optional(),
    markings: fields.markings.optional(),
    nationalRules: fields.nationalRules.optional(),
    importerNeeded: fields.importerNeeded.optional(),
    gpsrContactNeeded: fields.gpsrContactNeeded.optional(),
    seq: fields.seq.optional(),
    note: fields.note.optional(),
    /** ON by default (a market a person adds is one the factory sells to); OFF needs `offReason`. */
    switchedOn: z.boolean().optional(),
    offReason: z.string().trim().min(3).max(REASON_MAX).optional(),
  }),
  response: { 200: output({ market: marketView }) },
})

export const editMarketContract = defineContract({
  params: marketParams,
  body: input({
    version: version(),
    name: fields.name.optional(),
    nameI18n: fields.nameI18n.optional(),
    labelLanguages: fields.labelLanguages.optional(),
    docLanguages: fields.docLanguages.optional(),
    userInfoLanguages: fields.userInfoLanguages.optional(),
    markings: fields.markings.optional(),
    nationalRules: fields.nationalRules.optional(),
    importerNeeded: fields.importerNeeded.optional(),
    gpsrContactNeeded: fields.gpsrContactNeeded.optional(),
    seq: fields.seq.optional(),
    note: fields.note.optional(),
    /** ARCHIVED: no longer used (requirements and operators that name it keep the code); ACTIVE: restored. */
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  }),
  response: { 200: output({ market: marketView }) },
})

export const switchMarketContract = defineContract({
  params: marketParams,
  body: input({
    version: version(),
    on: z.boolean(),
    /** OFF: why, in words (the Owner question it waits for), 3 to 500 characters. ON: optional words for the audit. */
    reason: z.string().trim().min(3).max(REASON_MAX).optional(),
  }),
  response: { 200: output({ market: marketView }) },
})

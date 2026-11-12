import { z } from 'zod'
import { id, input, instant, output, unitPrice } from '../../core/contracts'
import { money } from '../../money/marked'
import { DEPOSIT_KINDS, SALES_FEE_KINDS, STORED_DEPOSIT_KINDS } from '../quotes/quotes'
import { ACCEPTANCE_MODES, STORED_ACCEPTANCE_MODES } from '../quote-terms/rules'
import { TEMPLATE_LIMITS, TEMPLATE_LINE_KINDS } from './rules'

/**
 * Quote templates' contracts (B-W2b-294): what apps/factory-api's modules/sales/quote-templates accepts and answers. Every
 * write names the template's `version` (the edit-conflict guard) but the first. A template line's unit price is money.price:
 * dropped for a caller without the price grain, refused in a body from one. "Used" counts the quotes started from it.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().max(max)
const pct = z.string().trim().max(12)
const sizes = z.record(z.string().trim().min(1).max(40), z.number().int().min(1).max(TEMPLATE_LIMITS.pieces))

export const templateParams = input({ templateId: id() })

export const templateListQuery = input({
  /** The templates a quote of this company may start from (its own and every company's); none: every one the caller reaches. */
  companyId: id().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  /** Name, case-insensitive. */
  q: z.string().trim().min(1).max(100).optional(),
})

const headerShape = {
  description: words(TEMPLATE_LIMITS.description).nullish(),
  language: z.enum(['it', 'en']).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  /** Days a quote started from it stands; null: the sales settings' days. */
  validityDays: z.number().int().min(1).max(TEMPLATE_LIMITS.validityDays).nullish(),
  firmOffer: z.boolean().optional(),
  acceptanceMode: z.enum(ACCEPTANCE_MODES).optional(),
  /** Percent of the gross total asked at acceptance; null: the customer's or the settings' deposit. */
  depositPct: pct.nullish(),
  depositKind: z.enum(DEPOSIT_KINDS).nullish(),
  /** Payment terms of the library (of the template's company or tenant-wide); null: the customer's. */
  paymentTermsId: id().nullish(),
  termsText: words(TEMPLATE_LIMITS.termsText).nullish(),
  termsVersion: words(TEMPLATE_LIMITS.termsVersion).nullish(),
  incoterm: z.string().trim().toUpperCase().max(3).nullish(),
  incotermPlace: words(120).nullish(),
  shipComplete: z.boolean().optional(),
}

export const templateLineBody = input({
  seq: z.number().int().min(1).max(100_000),
  section: words(TEMPLATE_LIMITS.section).nullish(),
  kind: z.enum(TEMPLATE_LINE_KINDS).default('SIZE_GRID'),
  feeKind: z.enum(SALES_FEE_KINDS).nullish(),
  styleId: id(),
  /** None: chosen when the quote is made. */
  colourwayId: id().nullish(),
  /** Pieces per size ({ "50": 2, "52": 4 }); none: typed when the quote is made. */
  sizes: sizes.nullish(),
  /** The template's currency, on the price basis of the quote; none: the customer's price list prices it. */
  unitPrice: money.price(unitPrice().nullish()),
  description: words(TEMPLATE_LIMITS.lineDescription).nullish(),
  note: words(TEMPLATE_LIMITS.lineNote).nullish(),
})
export type TemplateLineBody = z.output<typeof templateLineBody>

export const createTemplateBody = input({
  /** Its company; null: every company of the tenant (a grant over every company). */
  companyId: id().nullable(),
  name: words(TEMPLATE_LIMITS.name).min(1),
  ...headerShape,
  lines: z.array(templateLineBody).max(TEMPLATE_LIMITS.lines).default([]),
})
export type CreateTemplateBody = z.output<typeof createTemplateBody>

export const updateTemplateBody = input({ version: version(), name: words(TEMPLATE_LIMITS.name).min(1).optional(), ...headerShape })
export type UpdateTemplateBody = z.output<typeof updateTemplateBody>

export const replaceLinesBody = input({ version: version(), lines: z.array(templateLineBody).max(TEMPLATE_LIMITS.lines) })
export type ReplaceLinesBody = z.output<typeof replaceLinesBody>

export const templateVersionBody = input({ version: version() })

export const fromQuoteBody = input({
  /** The quote whose current version becomes the template (its lines, sections, terms). */
  quoteId: id(),
  name: words(TEMPLATE_LIMITS.name).min(1),
  description: words(TEMPLATE_LIMITS.description).nullish(),
  /** The quote's company (default) or every company (null; its styles must be tenant-wide). */
  companyId: id().nullish(),
})
export type FromQuoteBody = z.output<typeof fromQuoteBody>

export const startQuoteBody = input({
  /** The selling company (a template of every company serves each). */
  companyId: id(),
  partyId: id(),
  contactId: id().nullish(),
  customerRef: words(100).nullish(),
  /** What is picked per template line: a colourway left open, the pieces typed at use, or the line left out. */
  lines: z
    .array(input({ templateLineId: id(), colourwayId: id().nullish(), sizes: sizes.nullish(), skip: z.boolean().optional() }))
    .max(TEMPLATE_LIMITS.lines)
    .default([]),
})
export type StartQuoteBody = z.output<typeof startQuoteBody>

const ref = output({ id: id(), code: z.string(), name: z.string() })

export const templateRowView = output({
  id: id(),
  companyId: id().nullable(),
  /** null: every company. */
  company: ref.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  language: z.string(),
  currency: z.string(),
  validityDays: z.number().int().nullable(),
  acceptanceMode: z.enum(STORED_ACCEPTANCE_MODES),
  incoterm: z.string().nullable(),
  incotermPlace: z.string().nullable(),
  shipComplete: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  lineCount: z.number().int(),
  sections: z.array(z.string()),
  /** The quotes started from it. */
  used: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const templateLineView = output({
  id: id(),
  seq: z.number().int(),
  section: z.string().nullable(),
  kind: z.enum(TEMPLATE_LINE_KINDS),
  feeKind: z.enum(SALES_FEE_KINDS).nullable(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string(), status: z.string() }),
  colourwayId: id().nullable(),
  colourway: output({ code: z.string(), name: z.string() }).nullable(),
  sizes: z.record(z.string(), z.number().int()).nullable(),
  pieces: z.number().int(),
  unitPrice: money.price(z.string().nullable()),
  description: z.string().nullable(),
  note: z.string().nullable(),
})

export const templateView = output({
  ...templateRowView.shape,
  firmOffer: z.boolean(),
  depositPct: z.string().nullable(),
  depositKind: z.enum(STORED_DEPOSIT_KINDS).nullable(),
  paymentTermsId: id().nullable(),
  paymentTermsName: z.string().nullable(),
  termsText: z.string().nullable(),
  termsVersion: z.string().nullable(),
  lines: z.array(templateLineView),
  /** The caller may change it (quotes.templates.manage over its company, or over every company). */
  mayManage: z.boolean(),
  createdById: id().nullable(),
  createdAt: instant(),
})

export const templateListView = output({ templates: z.array(templateRowView), mayCreate: z.boolean() })
export const templateAnswer = output({ template: templateView })

export const leftOutView = output({ seq: z.number().int(), size: z.string().nullable(), reason: z.string() })

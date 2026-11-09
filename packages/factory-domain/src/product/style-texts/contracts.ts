import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { DECLARATION_SENDERS, PRIVATE_LABEL_SHOWN_TO } from './private-label'
import { TEXT_LIMITS, TEXT_SOURCES } from './rules'

/**
 * The contracts of a style's texts per language and its private label (B-W2b-227; PRD-019, PRD-010): what apps/factory-api's
 * modules/product/style-texts accepts and answers. No money, no person but the id of who wrote a text first.
 */

const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(500)

export const styleParams = input({ styleId: id() })
export const styleLanguageParams = input({ styleId: id(), language: z.string().trim().min(2).max(TEXT_LIMITS.language) })

/** `?language=` the text a reader in that language gets (with where it came from). */
export const textsQuery = input({ language: z.string().trim().min(2).max(TEXT_LIMITS.language).optional() })

/**
 * A text in a language, made or changed: the name (one line), the short description (one line, null: none) and the long one
 * (paragraphs, null: none). `version`: the row's, to change it; left out: a new language.
 */
export const putTextBody = input({
  version: version().optional(),
  name: z.string().max(TEXT_LIMITS.name * 2),
  shortDescription: z.string().max(TEXT_LIMITS.shortDescription * 2).nullable().optional(),
  longDescription: z.string().max(TEXT_LIMITS.longDescription * 2).nullable().optional(),
  reason: reason().optional(),
})
export type PutTextBody = z.output<typeof putTextBody>

/** A language removed (the reader falls back to the next text): the row's version. */
export const removeTextBody = input({ version: version(), reason: reason().optional() })
export type RemoveTextBody = z.output<typeof removeTextBody>

const textRow = output({
  id: id(),
  language: z.string(),
  name: z.string(),
  shortDescription: z.string().nullable(),
  longDescription: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
})

const resolved = output({
  language: z.string(),
  /** The language of the words given (null: the style's own name). */
  from: z.string().nullable(),
  source: z.enum(TEXT_SOURCES),
  name: z.string(),
  shortDescription: z.string().nullable(),
  longDescription: z.string().nullable(),
})

const refusal = output({ code: z.string(), message: z.string() })

/** A style's texts: every language written, W1's own names, the company's language and, asked, what a reader gets. */
export const textsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), version: z.number().int() }),
  /** The company's language: the fallback of a language with no text. */
  companyLanguage: z.string(),
  /** W1's names in Italian and English (Style.nameI18n): a reader's fallback after the text of its language. */
  styleNames: z.record(z.string(), z.string()),
  texts: z.array(textRow),
  /** With `?language=`: the text a reader in that language gets. */
  resolved: resolved.nullable(),
  /** Why the texts may not change now (the style's edit rule, archived), or null. */
  editRefusal: refusal.nullable(),
})
export type TextsView = z.infer<typeof textsView>

// ---- private label ----------------------------------------------------------------------------------------------------

/** The brand a style is made for (null: our own collection) and under whose name it is sold. At the style's version. */
export const privateLabelBody = input({
  version: version(),
  brandPartyId: id().nullable(),
  soldUnderOurName: z.boolean(),
  reason: reason().optional(),
})
export type PrivateLabelBody = z.output<typeof privateLabelBody>

const party = output({ id: id(), code: z.string(), name: z.string() })

export const privateLabelView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), version: z.number().int() }),
  /** The brand it is made for: the private-label mark (null: our own collection). */
  brand: party.nullable(),
  soldUnderOurName: z.boolean(),
  /** Who sees it in the portal. */
  shownTo: z.enum(PRIVATE_LABEL_SHOWN_TO),
  /** Who sends its declaration of conformity (Owner 11-09 question 3). */
  declarationSender: z.enum(DECLARATION_SENDERS),
  /**
   * Other customers' open quotes and orders that name the style (a private-label style: what was sold before keeps going,
   * but the portal offers it to its brand only). Counts of the records the person may read.
   */
  otherCustomers: output({ openQuotes: z.number().int(), openOrders: z.number().int(), parties: z.array(party) }),
  warnings: z.array(output({ code: z.string(), message: z.string() })),
})
export type PrivateLabelView = z.infer<typeof privateLabelView>

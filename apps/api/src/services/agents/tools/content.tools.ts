/**
 * MCP full control — the content read tools (docs/mcp-full-control/sections/03-content.md §3).
 *
 *   product-content     one family's text and attributes in one language, shared or on one listing (channel + market),
 *                       per row and per cell, from the product sheet's own read (`getInformationSheet`) (T3)
 *   translation-status  which languages are missing, AI drafts or outdated, per product and field, from the one
 *                       content resolver (`resolveContentBatch`) (T3)
 *   content-guidelines  the glossary (words to use and to avoid) and the brand voice for a brand, market and language,
 *                       from the terminology service and `readBrandVoice` (T4)
 *   content-gaps        the coordinates whose required text or attributes are missing, from the readiness Nexus records
 *                       (`ReadinessIndex`); what was never recorded, or could not be checked, is said so — never read as
 *                       complete (T9)
 *
 * Read-only and low risk: they read this business's own database. No marketplace call: the coordinate a caller may name
 * is Amazon, eBay or Etsy (the Shopify sheet reads Shopify itself, so Shopify is read with shopify-content; D3 = a). The
 * business is the one call-tool.ts bound; no argument names one. Products are named by Nexus id or SKU, in this business.
 *
 * Never returned: the sheet's write tokens (`writeField`, `writeTarget`, `contentAddress`, the acknowledgement). A change
 * tool looks them up again on the server; Claude never echoes one.
 */

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import { formerNamesOf } from '@nexus/shared/sheet-names'
import prisma from '../../../db.js'
import type { AgentTool } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import { normalizeLanguage } from '../../pim/content-language.js'
import { PRIMARY_CONTENT_LOCALE } from '../../pim/content-locale.js'
import { contentField, isLocalizableContent, resolveContentBatch, translationMissing, type ContentProduct, type ResolvedContent } from '../../pim/content-resolver.js'
import { availableContentLanguages, marketLanguages } from '../../pim/market-languages.js'
import type { SheetColumn } from '../../pim/sheet-columns.service.js'
import type { StudioCellValue, StudioRow, StudioSheet } from '../../pim/studio-sheet.service.js'
import { effectiveGlossary, listTerminology } from '../../ai/terminology.service.js'
import { readBrandVoice } from '../../ai/brand-voice.service.js'
import {
  DEFAULT_PAGE_SIZE, InvalidCursorError, MAX_CURSOR_LENGTH, MAX_PAGE_SIZE, cursorScope, decodeCursor, fitPage, pageOf, pageSize,
  type CursorPosition,
} from '../../../lib/pagination/cursor.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'

/** Every channel a coordinate may name; Shopify is answered in words (`channelNotHere`), never by a bad-argument error. */
export const COORDINATE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const

/** Why a coordinate tool does not work on this channel, or null when it does (Amazon, eBay, Etsy — E5b: the Etsy sheet). */
export function channelNotHere(channel: string, shopify: string): string | null {
  return channel === 'SHOPIFY' ? shopify : null
}
/** A family's variations shown with its parent (the plan: parent + up to 20). */
const MAX_VARIATIONS = 20
/** Fields shown when the caller names none; the rest are named in `moreFields`. */
const DEFAULT_FIELDS = 40
const MAX_NAMED_FIELDS = 50
const MAX_OPTIONS = 40
/** One answer's JSON budget: above it the last variations are left out, and the answer says so. */
const ANSWER_BYTES = 60_000
const MAX_PRODUCTS = 250
const MAX_LANGUAGES = 20
/** The four native content fields translation-status reports on. */
const CONTENT_FIELDS = ['title', 'description', 'bulletPoints', 'keywords'] as const

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const blank = (value: unknown) => value == null || value === '' || (Array.isArray(value) && value.every(blank))
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
export const primaryLanguage = () => normalizeLanguage(PRIMARY_CONTENT_LOCALE)

export const languageArg = z.string().trim().min(2).max(10)

/** A language tag as content stores it (`de-DE` → `de`), or the refusal a caller reads. */
export function languageOf(raw: string): { language: string } | { error: string } {
  try {
    return { language: normalizeLanguage(raw) }
  } catch {
    return { error: `"${raw}" is not a language. Use a two-letter code such as it, de, fr or en.` }
  }
}

/** A product of this business that is not deleted, by Nexus id first and then by SKU. */
export async function liveProductByRef(ref: string): Promise<{ id: string; sku: string; parentId: string | null } | null> {
  const select = { id: true, sku: true, parentId: true } as const
  return (await prisma.product.findFirst({ where: { id: ref, deletedAt: null }, select }))
    ?? prisma.product.findFirst({ where: { sku: ref, deletedAt: null }, select })
}

// ── Review state: one vocabulary for both tools ───────────────────────────────────────────────────────

/**
 * Where a piece of text stands for publishing, in the language asked for:
 *   missing            no text in this language (empty, or the cell shows another language's text as a fallback)
 *   source             the primary language's own text (it carries no review flag)
 *   reviewed           a person wrote or reviewed it, and the source has not changed since
 *   outdated           reviewed, but the source text changed after it was written
 *   ai-draft           machine text nobody reviewed: Nexus refuses to publish it (publish-review-gate.ts)
 *   ai-draft-outdated  both
 */
export type ReviewState = 'missing' | 'source' | 'reviewed' | 'outdated' | 'ai-draft' | 'ai-draft-outdated'

export function reviewState(content: Pick<ResolvedContent, 'value' | 'tier' | 'language' | 'translation'>, requested: string): ReviewState | null {
  if (blank(content.value) || (content.language && translationMissing({ language: content.language }, requested))) return 'missing'
  const t = content.translation
  if (t) {
    const machine = t.source !== 'manual' && !t.reviewedAt
    if (machine) return t.outdated ? 'ai-draft-outdated' : 'ai-draft'
    return t.outdated ? 'outdated' : 'reviewed'
  }
  if (content.tier === 'source') return 'source'
  // A legacy listing pin carries no review facts: it is a person's own listing text (the publish gate passes it).
  if (content.tier === 'pin' || content.tier === 'language') return 'reviewed'
  // Computed (a channel mapping rule or a formula) over the primary language's text: that text's own state.
  return content.language === primaryLanguage() ? 'source' : null
}

// ── product-content ───────────────────────────────────────────────────────────────────────────────────

export interface Field {
  /** The name the content tools use: title, description, bulletPoints, keywords, or the attribute's key. */
  name: string
  content: boolean
  /** The sheet's columns behind it: one, or a list's slots in order. */
  columns: SheetColumn[]
}

interface FieldFacts {
  field: string
  label: string
  kind: string
  content: boolean
  /** list fields: the most items the channel takes (null = no limit). */
  maxItems?: number | null
  maxLength?: number
  maxBytes?: number
  limitFrom?: string
  options?: string[]
  moreOptions?: number
  /** true when the channel accepts only the options (a value off the list warns). */
  optionsOnly?: boolean
  unitOptions?: string[]
}

type Cell = Record<string, unknown>

/**
 * A channel's column groups that are not text or attributes: the offer (price, quantity, condition), photos, shipping,
 * policies, variations and classification belong to the listings part, not to content.
 * Integration (main #246): the sheet now shows every column in one set of groups (`@nexus/shared/sheet-groups`, keys
 * `sheet:<group>`); classification (product type, category) sits in Offer Identity with the SKU, parent and channel ids,
 * none of which is text or an attribute, so `offer-identity` is not content either.
 */
export const NOT_CONTENT_GROUPS = new Set(['offer', 'images', 'shipping', 'policies', 'variations', 'classification', 'offer-identity'])

/** The fields the sheet serves that are text or attributes: list slots merged into one field. */
function contentAndAttributeFields(columns: SheetColumn[]): Field[] {
  const byName = new Map<string, Field>()
  for (const column of columns) {
    if (column.kind === 'variationTheme' || column.managedBy === 'productMedia') continue
    const base = column.slot?.of ?? column.key
    const content = isLocalizableContent(base, column.storage)
    if (!content && column.storage !== 'categoryAttributes' && column.storage !== 'listing') continue
    if (!content && NOT_CONTENT_GROUPS.has(column.groupKey?.split(':').pop() ?? '')) continue
    const name = content ? contentField(base) : base
    const field = byName.get(name) ?? { name, content, columns: [] }
    field.columns.push(column)
    byName.set(name, field)
  }
  for (const field of byName.values()) field.columns.sort((a, b) => (a.slot?.index ?? 0) - (b.slot?.index ?? 0))
  return [...byName.values()]
}

export function factsOf(field: Field): FieldFacts {
  const first = field.columns[0]
  const options = first.options ?? []
  return {
    field: field.name,
    label: first.slot?.label ?? first.label,
    kind: first.kind,
    content: field.content,
    ...(first.slot ? { maxItems: first.slot.max } : first.cardinality ? { maxItems: first.cardinality.max } : {}),
    ...(first.maxLength != null ? { maxLength: first.maxLength } : {}),
    ...(first.maxBytes != null ? { maxBytes: first.maxBytes } : {}),
    ...(first.capFrom ? { limitFrom: first.capFrom } : {}),
    ...(options.length ? { options: options.slice(0, MAX_OPTIONS) } : {}),
    ...(options.length > MAX_OPTIONS ? { moreOptions: options.length - MAX_OPTIONS } : {}),
    ...(options.length && first.mode === 'strict' ? { optionsOnly: true } : {}),
    ...(first.unitOptions?.length ? { unitOptions: first.unitOptions } : {}),
  }
}

const ATTRIBUTE_LAYER: Record<string, string> = {
  master: 'shared', variant: 'variation', alias: 'listing', channel: 'listing', linked: 'linked', default: 'none',
}

export type RequiredCheck = (column: SheetColumn, row: StudioRow) => boolean

/** One field of one row: its value and where it comes from. Never a write token. */
export function cellOf(field: Field, row: StudioRow, requested: string, channelScope: boolean, required: RequiredCheck): Cell | null {
  const cells = field.columns.map((column) => row.values[column.key]).filter((cell): cell is StudioCellValue => !!cell)
  if (!cells.length) return null
  const head = cells[0]
  // A list field's value is its slots' values, without the empty slots at its end.
  const value = field.columns[0].slot ? (() => {
    const items = field.columns.map((column) => row.values[column.key]?.value ?? null)
    while (items.length && blank(items[items.length - 1])) items.pop()
    return items
  })() : head.value
  const out: Cell = { value }
  if (field.content) {
    // The sheet says `computed` when a channel mapping rule or a formula supplies the value: name which.
    out.layer = head.tier !== 'computed' ? head.tier ?? 'none' : head.formula ? 'formula' : head.mapped?.status === 'mapped' ? 'mapped' : blank(value) ? 'none' : 'computed'
    if (head.language && head.language !== requested) out.language = head.language
    const review = reviewState({ value, tier: head.tier ?? 'computed', language: head.language ?? requested, translation: head.translation }, requested)
    if (review) out.review = review
    // On a listing, a content cell that is not the listing's own pin uses the shared text (studio-sheet's routing).
    if (channelScope) out.followsShared = head.affectsAllChannels
    if (head.provenance?.from) out.from = head.provenance.from
  } else {
    out.layer = ATTRIBUTE_LAYER[head.layer] ?? head.layer
    if (channelScope && field.columns[0].storage === 'categoryAttributes') out.followsShared = head.layer === 'master' || head.layer === 'variant'
  }
  if (head.inherited) out.fromParent = true
  if (field.columns.some((column) => required(column, row))) out.required = true
  const blocked = cells.find((cell) => !cell.editable)
  if (blocked) {
    out.editable = false
    out.blockedReason = blocked.writeBlockedReason ?? 'This field cannot be edited here.'
  }
  return out
}

const productContentInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product: a Nexus product id or a SKU (a variation names its family)'),
  language: languageArg.optional()
    .describe('the language to read, e.g. it, de, fr, en (default: the primary language, the source text)'),
  coordinate: z.object({
    channel: z.preprocess(upper, z.enum(COORDINATE_CHANNELS)).describe('AMAZON, EBAY or ETSY (Shopify: use shopify-content)'),
    market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Etsy'),
    accountId: z.string().trim().min(1).max(64).optional().describe('the channel account, when the business has more than one'),
    aliasKey: z.string().trim().min(1).max(64).optional().describe('a second listing of the product on this coordinate (its alias key)'),
  }).optional().describe('read what one listing (channel + market) shows instead of the shared text'),
  fields: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_NAMED_FIELDS).optional()
    .describe('only these fields: title, description, bulletPoints, keywords, or attribute keys or labels (default: the text and up to 40 attributes)'),
})

/** The market whose channels' rules a shared read is held to: one carrying the language, else the readiness rule's. */
async function sharedMarket(language: string): Promise<string | null> {
  const markets = await prisma.marketplace.findMany({
    where: { isActive: true, NOT: { code: 'GLOBAL' } },
    orderBy: [{ channel: 'asc' }, { code: 'asc' }],
    select: { channel: true, code: true, languages: true, language: true },
  })
  const carries = (row: (typeof markets)[number]) => {
    try {
      return marketLanguages(row.channel, row.code, [row]).includes(language)
    } catch {
      return false
    }
  }
  return (markets.find(carries) ?? markets[0])?.code ?? null
}

/** A sheet refusal a caller can act on, said plainly; anything else is a real failure. */
export function sheetRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; message?: unknown; statusCode?: unknown }
  if (e?.code === 'unknown_product') return PRODUCT_NOT_FOUND
  if (e?.code === 'scope_not_available' || e?.code === 'unknown_market' || e?.code === 'market_languages_unconfigured') return String(e.message)
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500 && typeof e.message === 'string') return e.message
  return null
}

const productContent: AgentTool = {
  name: 'product-content',
  title: 'Product content',
  input: productContentInput,
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Read one product family\'s text (title, bullet points, description, keywords) and attributes in one language, '
    + 'per row (the parent and up to 20 variations) and per field, exactly as the product sheet shows them. Without a '
    + 'coordinate it reads the shared text; with one (channel + market) it reads what that listing shows. Each cell says '
    + 'its value; its layer (source = the primary-language text, language = shared text in another language, pin = this '
    + 'listing\'s own text, mapped = the channel\'s mapping rule builds it from the text named in from, formula, none; for '
    + 'attributes shared, variation, listing, linked or none); whether a listing follows the shared text; its '
    + 'review state (missing, source, reviewed, outdated, ai-draft, ai-draft-outdated); whether it is required; and when '
    + 'it cannot be edited, why. A variation\'s cell that only repeats the parent\'s value says sameAsParent. Field '
    + 'limits and options are listed once per field.',
  async handler(args) {
    const a = args as z.infer<typeof productContentInput>
    const named = await liveProductByRef(a.product)
    if (!named) return { ok: false, error: PRODUCT_NOT_FOUND }
    const asked = a.language ? languageOf(a.language) : { language: primaryLanguage() }
    if ('error' in asked) return { ok: false, error: asked.error }
    const { language } = asked
    const coordinate = a.coordinate
    const elsewhere = coordinate && channelNotHere(coordinate.channel, 'A Shopify listing is read with shopify-content: it reads the store\'s own fields live.')
    if (elsewhere) return { ok: false, error: elsewhere }
    const market = coordinate ? coordinate.market : await sharedMarket(language)
    if (!market) return { ok: false, error: 'This business has no active marketplace, so Nexus has no field rules to read its content against.' }

    let sheet: StudioSheet
    try {
      const { getInformationSheet } = await import('../../pim/information-sheet.js')
      sheet = await getInformationSheet({
        productId: named.id,
        scope: coordinate ? 'channel' : 'master',
        market,
        locale: language,
        ...(coordinate ? { channel: coordinate.channel, ...(coordinate.accountId ? { accountId: coordinate.accountId } : {}) } : {}),
      })
    } catch (error) {
      const refusal = sheetRefusal(error)
      if (refusal) return { ok: false, error: refusal }
      throw error
    }
    const { completenessFor } = await import('../../pim/sheet-rows.service.js')
    // Required here = the sheet's own completeness rule for this one column on this row.
    const required: RequiredCheck = (column, row) => completenessFor([column], {
      isParent: row.productRole ? row.productRole === 'parent' : row.isParent, productType: row.productType, familyId: row.familyId ?? null,
    }, row.values as never).required.total > 0

    const alias = coordinate?.aliasKey ?? null
    const familyRows = sheet.rows.filter((row) => (row.aliasId ?? null) === alias)
    if (!familyRows.length) {
      return { ok: false, error: alias ? `There is no listing "${alias}" of this product on ${sheet.scope.label}.` : PRODUCT_NOT_FOUND }
    }
    const parent = familyRows.find((row) => row.id === sheet.family.id) ?? familyRows[0]
    const variations = familyRows.filter((row) => row !== parent)
    let shown = variations.slice(0, MAX_VARIATIONS)
    const namedVariation = variations.find((row) => row.id === named.id)
    if (namedVariation && !shown.includes(namedVariation)) shown = [...shown.slice(0, MAX_VARIATIONS - 1), namedVariation]

    // Which fields: the ones named, else the text and up to DEFAULT_FIELDS attributes (required and filled ones first).
    const all = contentAndAttributeFields(sheet.columns)
    const unknownFields: string[] = []
    let fields: Field[]
    if (a.fields) {
      const wanted = new Map<string, Field>()
      for (const raw of a.fields) {
        const key = raw.trim().toLowerCase()
        const hit = all.find((field) => field.name.toLowerCase() === key
          || field.columns.some((column) => [column.key, column.writeField, column.label, column.slot?.label].some((name) => name?.toLowerCase() === key)))
          // W3-6 — then a column's former names ("Name" → Title, "Quantity" → eBay's Unit quantity); a current name wins.
          // W3-3 — and the names a dictionary field had in the content language ("Colore" → Color).
          ?? all.find((field) => field.columns.some((column) => [...formerNamesOf(column.key), ...(column.formerNames ?? [])].some((name) => name.toLowerCase() === key)))
        if (hit) wanted.set(hit.name, hit)
        else unknownFields.push(raw)
      }
      fields = [...wanted.values()]
    } else {
      const rows = [parent, ...shown]
      const rank = (field: Field) => field.content ? 0
        : rows.some((row) => field.columns.some((column) => required(column, row))) ? 1
        : rows.some((row) => field.columns.some((column) => !blank(row.values[column.key]?.value))) ? 2 : 3
      fields = [...all].sort((x, y) => rank(x) - rank(y))
    }
    const moreFields = a.fields ? [] : fields.slice(DEFAULT_FIELDS).map((field) => field.name)
    if (!a.fields) fields = fields.slice(0, DEFAULT_FIELDS)

    const channelScope = !!coordinate
    const rowOut = (row: StudioRow, parentCells?: Record<string, Cell | null>) => {
      const cells: Record<string, Cell> = {}
      for (const field of fields) {
        const cell = cellOf(field, row, language, channelScope, required)
        if (!cell) continue
        const fromParent = parentCells?.[field.name]
        if (fromParent && !blank(cell.value) && same(cell.value, fromParent.value)) {
          delete cell.value
          cell.sameAsParent = true
        }
        cells[field.name] = cell
      }
      return {
        id: row.id,
        sku: row.sku,
        role: row.productRole ?? (row.isParent ? 'parent' : row.parentId ? 'child' : 'standalone'),
        ...(channelScope ? { listing: row.listing ? { status: row.listing.listingStatus, published: !!row.listing.isPublished } : null } : {}),
        ...(row.completeness.required.missing.length ? { requiredMissing: row.completeness.required.missing.map((m) => m.label) } : {}),
        cells,
      }
    }
    const parentCells = Object.fromEntries(fields.map((field) => [field.name, cellOf(field, parent, language, channelScope, required)]))
    const head = rowOut(parent)
    let rows = [head, ...shown.map((row) => rowOut(row, parentCells))]

    const data = (rowsNow: typeof rows) => ({
      product: { id: sheet.family.id, sku: sheet.family.sku, name: sheet.family.name },
      ...(named.id !== sheet.family.id ? { asked: { id: named.id, sku: named.sku } } : {}),
      language,
      primaryLanguage: primaryLanguage(),
      scope: coordinate ? sheet.scope.label : 'shared',
      ...(coordinate ? {
        coordinate: {
          channel: coordinate.channel, market: coordinate.market,
          ...(coordinate.accountId ? { accountId: coordinate.accountId } : {}), ...(alias ? { aliasKey: alias } : {}),
        },
        listingNote: 'A row with listing null has no listing on this coordinate yet.',
      } : { rulesFrom: `the channels on ${market}` }),
      ...(sheet.meta.schemaMissing.length ? { rulesMissing: `Nexus has no field rules stored for ${sheet.meta.schemaMissing.join(', ')}: required fields and limits may be incomplete.` } : {}),
      fields: fields.map(factsOf),
      rows: rowsNow,
      ...(variations.length > rowsNow.length - 1 ? { moreVariations: variations.length - (rowsNow.length - 1) } : {}),
      ...(moreFields.length ? { moreFields, moreFieldsNote: 'Name any of these in fields to read them.' } : {}),
      ...(unknownFields.length ? { unknownFields } : {}),
    })
    // Held under the answer budget: the last variations go first, and moreVariations counts them.
    while (rows.length > 2 && Buffer.byteLength(JSON.stringify(data(rows))) > ANSWER_BYTES) rows = rows.slice(0, -1)
    return { ok: true, data: data(rows) }
  },
}

// ── translation-status ────────────────────────────────────────────────────────────────────────────────

const translationStatusInput = z.object({
  products: z.array(z.string().trim().min(1).max(191)).min(1).max(MAX_PRODUCTS)
    .describe(`the products: Nexus product ids or SKUs, 1 to ${MAX_PRODUCTS}`),
  languages: z.array(languageArg).min(1).max(MAX_LANGUAGES).optional()
    .describe('the languages to check, e.g. de, fr (default: every language of the business\'s active markets)'),
})

const TRANSLATION_SELECT = {
  id: true, sku: true, parentId: true, workspaceId: true,
  name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, variantAttributes: true,
  translations: true,
  parent: { select: { id: true, parentId: true, workspaceId: true, name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, variantAttributes: true, translations: true } },
} as const

const translationStatus: AgentTool = {
  name: 'translation-status',
  title: 'Translation status',
  input: translationStatusInput,
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'For 1 to 250 products, where their shared text stands in each language: per product, language and field (title, '
    + 'description, bulletPoints, keywords) one of missing (no text in that language: a variation without its own '
    + 'counts its parent\'s), source (the primary language\'s own text), reviewed, outdated (the source text changed '
    + 'after it was written), ai-draft (machine text nobody reviewed: Nexus will not publish it) or ai-draft-outdated. '
    + 'Each product lists the languages where every field is source or reviewed under complete, and the rest under '
    + 'gaps; totals count every state per language. A product named that is not found refuses the whole call.',
  async handler(args) {
    const a = args as z.infer<typeof translationStatusInput>
    const refs = [...new Set(a.products.map((ref) => ref.trim()))]
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, OR: [{ id: { in: refs } }, { sku: { in: refs } }] },
      select: TRANSLATION_SELECT,
    })
    const byRef = new Map<string, (typeof rows)[number]>()
    for (const row of rows) byRef.set(row.sku, row)
    for (const row of rows) byRef.set(row.id, row)
    const missing = refs.filter((ref) => !byRef.has(ref))
    if (missing.length) return { ok: false, error: `${PRODUCT_NOT_FOUND}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}` }
    let languages: string[]
    if (a.languages) {
      const parsed = a.languages.map(languageOf)
      const bad = parsed.find((p): p is { error: string } => 'error' in p)
      if (bad) return { ok: false, error: bad.error }
      languages = [...new Set(parsed.map((p) => (p as { language: string }).language))]
    } else {
      languages = (await availableContentLanguages()).sort()
      if (!languages.length) return { ok: false, error: 'This business has no active marketplace with a language: name the languages to check.' }
    }

    const primary = primaryLanguage()
    const totals: Record<string, Partial<Record<ReviewState, number>>> = Object.fromEntries(languages.map((l) => [l, {}]))
    const seen = new Set<string>()
    const products = []
    for (const ref of refs) {
      const product = byRef.get(ref)!
      if (seen.has(product.id)) continue
      seen.add(product.id)
      const complete: string[] = []
      const gaps: Record<string, Partial<Record<(typeof CONTENT_FIELDS)[number], ReviewState>>> = {}
      let unreadable: string | null = null
      for (const language of languages) {
        let fields: Record<string, ResolvedContent>
        try {
          fields = resolveContentBatch({
            members: [{ product: product as unknown as ContentProduct, parent: (product.parent ?? null) as unknown as ContentProduct | null }],
            fields: CONTENT_FIELDS,
            addresses: [{ requested: language }],
          })[0].fields
        } catch (error) {
          unreadable = error instanceof Error ? error.message : 'its stored text could not be read'
          break
        }
        const states = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, reviewState(fields[field], language) ?? 'missing'])) as Record<(typeof CONTENT_FIELDS)[number], ReviewState>
        for (const state of Object.values(states)) totals[language][state] = (totals[language][state] ?? 0) + 1
        const open = Object.entries(states).filter(([, state]) => state !== 'reviewed' && state !== 'source')
        if (open.length) gaps[language] = Object.fromEntries(open)
        else complete.push(language)
      }
      products.push({
        id: product.id,
        sku: product.sku,
        ...(unreadable ? { unreadable } : { complete, ...(Object.keys(gaps).length ? { gaps } : {}) }),
      })
    }
    return {
      ok: true,
      data: { primaryLanguage: primary, languages, fields: CONTENT_FIELDS, products, totals },
    }
  },
}

// ── content-guidelines ────────────────────────────────────────────────────────────────────────────────

/** Glossary rows one answer names; the rest are counted. */
const MAX_GLOSSARY = 200

const contentGuidelinesInput = z.object({
  brand: z.string().trim().min(1).max(100).optional()
    .describe('the brand the text is for: its own glossary rows and voice win over the all-brand ones (default: every brand\'s rows)'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('the marketplace code, e.g. IT or DE (default: every market)'),
  language: languageArg.optional().describe('the language of the text, e.g. it or de (default: every language)'),
})

const contentGuidelines: AgentTool = {
  name: 'content-guidelines',
  title: 'Content guidelines',
  input: contentGuidelinesInput,
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'The business\'s writing rules before you write product text: its glossary (per row the preferred word, the words '
    + 'to avoid instead, why, and the brand, market and language it is for; brand null = every brand) and its brand '
    + 'voice (tone and style) for a brand, market and language. Most specific wins: a brand\'s own glossary row about a '
    + 'word replaces the all-brand row about the same word, a word the brand prefers is never an avoid word for it, and '
    + 'the brand voice is the one set for the closest match (brand + market + language first, the all-brand default '
    + 'last). Change previews flag avoid words found in the new text.',
  async handler(args) {
    const a = args as z.infer<typeof contentGuidelinesInput>
    let language: string | undefined
    if (a.language) {
      const parsed = languageOf(a.language)
      if ('error' in parsed) return { ok: false, error: parsed.error }
      language = parsed.language
    }
    const rows = await listTerminology({ ...(a.brand ? { brand: a.brand } : {}), ...(a.market ? { marketplace: a.market } : {}), ...(language ? { language } : {}) })
    const glossary = effectiveGlossary(rows, a.brand ?? null).map((row) => ({
      preferred: row.preferred, avoid: row.avoid, context: row.context, brand: row.brand, market: row.marketplace, language: row.language,
    }))
    const voiceScope = { brand: a.brand ?? null, marketplace: a.market ?? null, language: language ?? null }
    // "Could not be read" is not "not set": the read's own error goes to the log, the answer says it is not known.
    const voice = await readBrandVoice(prisma as never, voiceScope).catch((error: unknown) => {
      logger.warn('[agents/content-guidelines] brand voice could not be read', { scope: voiceScope, error: error instanceof Error ? error.message : String(error) })
      return 'unreadable' as const
    })
    return {
      ok: true,
      data: {
        scope: { brand: a.brand ?? null, market: a.market ?? null, language: language ?? null },
        glossary: glossary.slice(0, MAX_GLOSSARY),
        ...(glossary.length > MAX_GLOSSARY ? { moreGlossary: glossary.length - MAX_GLOSSARY, moreGlossaryNote: 'Name a brand, market or language to narrow it.' } : {}),
        // The voice's operator memo (`notes`) is never shown: it is not guidance for the text.
        brandVoice: voice && voice !== 'unreadable' ? { text: voice.body, appliesTo: { brand: voice.brand, market: voice.marketplace, language: voice.language } } : null,
        ...(!glossary.length ? { glossaryNote: 'The business has no glossary rows for this scope.' } : {}),
        ...(voice === 'unreadable' ? { brandVoiceNote: 'The brand voice could not be read just now: whether one is set is not known. Try again.' }
          : !voice ? { brandVoiceNote: 'No brand voice is set for this scope.' } : {}),
      },
    }
  },
}

// ── content-gaps ──────────────────────────────────────────────────────────────────────────────────────

/** The shared product's rows (no channel), next to the channels. */
const GAP_CHANNELS = ['SHARED', ...Object.keys(CHANNEL_LABELS)] as [string, ...string[]]
/**
 * The states a caller may ask for. `absent` = Nexus could not check the requirements there (no field rules, none
 * defined, or the destination unavailable): NOT RECORDED, never complete. `checking` = values changed after the
 * answer was recorded; it is being rebuilt.
 */
const GAP_STATES = ['blocked', 'warn', 'absent', 'checking'] as const
/** Per row: names listed of each kind, the rest counted. */
const GAP_NAMES = 15
const GAP_REASON_CHARS = 200

interface MissingEntry { field?: string; label?: string; reason?: string; kind?: string; requiredEmpty?: boolean }

const contentGapsInput = z.object({
  channel: z.preprocess(upper, z.enum(GAP_CHANNELS)).optional()
    .describe('only this channel, or SHARED for the shared product text (no channel); default: all'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code, e.g. IT or DE'),
  language: languageArg.optional().describe('only this language, e.g. it or de'),
  state: z.enum(GAP_STATES).optional()
    .describe('only blocked (a required value is missing or invalid), warn, absent (requirements not recorded) or checking (being rebuilt after a change); default: every row that is not ready, and ready rows being rebuilt'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
})

const clipText = (text: string) => (text.length > GAP_REASON_CHARS ? `${text.slice(0, GAP_REASON_CHARS - 1)}…` : text)
const listed = <T>(items: T[]) => ({ shown: items.slice(0, GAP_NAMES), more: Math.max(0, items.length - GAP_NAMES) })

/** The rows strictly after a cursor's row, in the order productId, coordinateKey, language, id (all non-null). */
function gapsAfter(position: CursorPosition | null): Prisma.ReadinessIndexWhereInput {
  if (!position) return {}
  const [productId, coordinateKey, language] = position.values
  if (typeof productId !== 'string' || typeof coordinateKey !== 'string' || typeof language !== 'string') throw new InvalidCursorError()
  return {
    OR: [
      { productId: { gt: productId } },
      { productId, coordinateKey: { gt: coordinateKey } },
      { productId, coordinateKey, language: { gt: language } },
      { productId, coordinateKey, language, id: { gt: position.id } },
    ],
  }
}

type GapRecord = Prisma.ReadinessIndexGetPayload<{ include: { product: { select: { sku: true; name: true } } } }>

/** One recorded row, said honestly: what is missing, what was not recorded, and whether it is being rebuilt. */
function gapItem(record: GapRecord) {
  const entries = (Array.isArray(record.missing) ? record.missing : []) as MissingEntry[]
  const name = (entry: MissingEntry) => String(entry.label ?? entry.field ?? '?')
  const required = listed(entries.filter((entry) => entry.requiredEmpty === true).map(name))
  const untranslated = listed(entries.filter((entry) => entry.requiredEmpty !== true && entry.kind === 'language-fallback').map(name))
  const other = listed(entries.filter((entry) => entry.requiredEmpty !== true && entry.kind !== 'language-fallback')
    .map((entry) => clipText(entry.reason ? `${name(entry)}: ${entry.reason}` : name(entry))))
  const recorded = record.state !== 'absent'
  const empty = Math.max(0, record.requiredTotal - record.requiredFilled)
  const unnamed = recorded ? empty - entries.filter((entry) => entry.requiredEmpty === true).length : 0
  return {
    productId: record.productId,
    sku: record.product.sku,
    channel: record.channel ?? 'SHARED',
    ...(record.market ? { market: record.market } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.aliasId ? { aliasKey: record.aliasId } : {}),
    language: record.language,
    label: record.label,
    state: record.state,
    // `absent`: Nexus could not check the requirements here. Not recorded is never complete.
    recorded,
    ...(recorded ? { required: { filled: record.requiredFilled, total: record.requiredTotal } } : {}),
    ...(required.shown.length ? { missingRequired: required.shown, ...(required.more ? { moreMissingRequired: required.more } : {}) } : {}),
    ...(unnamed > 0 ? { unnamedEmpty: unnamed, unnamedNote: `${unnamed} required ${unnamed === 1 ? 'value is' : 'values are'} empty, but this row does not record which.` } : {}),
    ...(untranslated.shown.length ? { untranslated: untranslated.shown, ...(untranslated.more ? { moreUntranslated: untranslated.more } : {}) } : {}),
    ...(other.shown.length ? { otherIssues: other.shown, ...(other.more ? { moreOtherIssues: other.more } : {}) } : {}),
    // Why it could not be checked, or why it warns when it names nothing (the other notes only restate the counts).
    ...(record.note && (!recorded || (record.state === 'warn' && !entries.length)) ? { note: clipText(record.note) } : {}),
    checkedAt: record.computedAt.toISOString(),
    ...(record.pendingSince ? { checking: { since: record.pendingSince.toISOString(), note: 'Values changed after this was recorded: it is being rebuilt, and may no longer be right.' } } : {}),
  }
}

const contentGaps: AgentTool = {
  name: 'content-gaps',
  title: 'Content gaps',
  input: contentGapsInput,
  requires: [F.productsView, F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Where required text or attributes are missing, from the readiness Nexus records per product, coordinate (the '
    + 'shared product, or a channel + market listing) and language: each row\'s state (blocked, warn, absent), the '
    + 'required values filled of total, the missing required fields by name, the fields that show another language\'s '
    + 'text (untranslated) and other issues. Honest about what is not known: an absent row means Nexus could not check '
    + 'the requirements there (recorded false, with why) — never read it as complete; checking means values changed '
    + 'after it was recorded; and notRecorded counts the products or listings with nothing recorded at all. Pages '
    + 'with nextCursor.',
  async handler(args) {
    const a = args as z.infer<typeof contentGapsInput>
    try {
      let language: string | undefined
      if (a.language) {
        const parsed = languageOf(a.language)
        if ('error' in parsed) return { ok: false, error: parsed.error }
        language = parsed.language
      }
      if (a.channel === 'SHARED' && a.market) return { ok: false, error: 'The shared product text has no market: drop market, or name a channel.' }
      const channel = a.channel === 'SHARED' ? null : a.channel
      const coordinate: Prisma.ReadinessIndexWhereInput = {
        ...(a.channel ? { channel } : {}),
        ...(a.market ? { market: a.market } : {}),
        ...(language ? { language } : {}),
      }
      const where: Prisma.ReadinessIndexWhereInput = {
        product: { deletedAt: null },
        ...coordinate,
        ...(a.state === 'checking' ? { pendingSince: { not: null } }
          : a.state ? { state: a.state }
          // Default: every row that is not ready, and a ready row being rebuilt (its answer may be out of date).
          : { OR: [{ state: { not: 'ready' } }, { pendingSince: { not: null } }] }),
      }
      const scope = cursorScope('content-gaps', { business: workspaceIdForQuery(), channel: a.channel, market: a.market, language, state: a.state })
      const start = decodeCursor(scope, a.cursor)
      const size = pageSize(a.limit)
      const positionOf = (row: { productId: string; coordinateKey: string; language: string; id: string }): CursorPosition =>
        ({ values: [row.productId, row.coordinateKey, row.language], id: row.id })
      const [total, records] = await Promise.all([
        prisma.readinessIndex.count({ where }),
        prisma.readinessIndex.findMany({
          where: { AND: [where, gapsAfter(start)] },
          orderBy: [{ productId: 'asc' }, { coordinateKey: 'asc' }, { language: 'asc' }, { id: 'asc' }],
          take: size + 1,
          include: { product: { select: { sku: true, name: true } } },
        }),
      ])
      const page = pageOf(records, size, scope, positionOf)
      const items = page.items.map((record) => ({ item: gapItem(record), position: positionOf(record) }))
      const fitted = fitPage({ items, nextCursor: page.nextCursor }, scope, (entry) => entry.position)

      // What is not recorded at all: never complete, and never silently absent from the list.
      const recordedHere = await prisma.readinessIndex.count({ where: { product: { deletedAt: null }, ...coordinate } })
      let notRecorded: Record<string, unknown> | undefined
      if (a.channel && a.channel !== 'SHARED') {
        const listings = await prisma.channelListing.count({
          where: {
            channel: a.channel, ...(a.market ? { marketplace: a.market } : {}),
            product: { deletedAt: null, readinessIndex: { none: { channel: a.channel, ...(a.market ? { market: a.market } : {}), ...(language ? { language } : {}) } } },
          },
        })
        if (listings) notRecorded = { listings, note: `${listings} listing${listings === 1 ? '' : 's'} here ${listings === 1 ? 'has' : 'have'} no readiness recorded: whether anything is missing there is not known.` }
      } else if (!a.market) {
        const products = await prisma.product.count({
          where: { deletedAt: null, readinessIndex: { none: { channel: null, ...(language ? { language } : {}) } } },
        })
        if (products) notRecorded = { products, note: `${products} product${products === 1 ? '' : 's'} ${products === 1 ? 'has' : 'have'} no shared readiness recorded: whether anything is missing there is not known.` }
      }
      return {
        ok: true,
        data: {
          filter: { channel: a.channel ?? null, market: a.market ?? null, language: language ?? null, state: a.state ?? null },
          items: fitted.items.map((entry) => entry.item),
          nextCursor: fitted.nextCursor,
          total,
          ...(fitted.nextCursor ? { more: `${total} rows match; this page has ${fitted.items.length}${fitted.cut ? ` (cut from ${fitted.items.length + fitted.cut} to stay within the size limit)` : ''}. Call again with cursor set to nextCursor.` } : {}),
          ...(recordedHere === 0 ? { nothingRecorded: 'Nexus has recorded no readiness for this filter: it is not known whether anything is missing. Never read this as complete.' } : {}),
          ...(notRecorded ? { notRecorded } : {}),
        },
      }
    } catch (error) {
      if (error instanceof InvalidCursorError) return { ok: false, error: `content-gaps was called wrongly — cursor: ${error.message}` }
      throw error
    }
  },
}

export const CONTENT_TOOLS: AgentTool[] = [productContent, translationStatus, contentGuidelines, contentGaps]

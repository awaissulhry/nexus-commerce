/**
 * MCP full control — the content change tools (docs/mcp-full-control/sections/03-content.md §3, the Owner's d7–d9).
 *
 *   set-content          (T5) one product's shared text in one language: the primary language writes the source text,
 *                        any other the shared text in that language (a ProductTranslation row); `reset` drops a
 *                        language's own text so it shows the source again.
 *   set-listing-content  (T7) one listing's own text (a pin) on one coordinate (Amazon or eBay + market), returning a
 *                        field to the shared text (`follow`), and the listing's own channel attributes. Refused when the
 *                        coordinate has no listing yet, when a cell cannot be edited (its own reason), and when the
 *                        language is not one of the market's.
 *   bulk-content-change  (T8) the shared text of 1–25 products in one language, in one approval; one product that
 *                        cannot change refuses them all; at most 512 KB of arguments.
 *
 * Every change waits for a person in Nexus (`alwaysAsk`). Its preview is the product writer's own dry run
 * (`applyProductBulkEdits` → `writeContent`): from → to per field with the English meaning Claude wrote, the writer's
 * warnings, the glossary's avoid words found in the new text, and `reach` — the listings that follow this shared text
 * and those that keep their own pin. Approved, it re-reads, works the same plan again and writes it through the same
 * writer, guarded by the versions it read: Nexus only (d7, `queueOutbound: false` — the channels change through
 * Publish), stored as reviewed (d8: the approval is the review) with `sourceModel` "claude-mcp" on a translation row
 * and `mcp:<tool>` as the audit reason. Nothing is ever written by a preview.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { channelLabel } from '@nexus/shared/channel-label'
import type { ContentAddress } from '@nexus/shared/content-language'
import prisma from '../../../db.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import { NEXUS_ONLY } from './bulk.tools.js'
import { channelNotHere, COORDINATE_CHANNELS, languageArg, languageOf, liveProductByRef, NOT_CONTENT_GROUPS, primaryLanguage } from './content.tools.js'
import { CONTENT_COLUMNS } from '../../pim/content-locale.js'
import { contentField, isLocalizableContent, listingFollowsContent, resolveContent, type ContentProduct } from '../../pim/content-resolver.js'
import { contentListing } from '../../pim/content-read.js'
import { storedChannelState } from '../../pim/channel-value-mutation.js'
import type { SheetColumn } from '../../pim/sheet-columns.service.js'
import type { StudioCellValue, StudioRow, StudioSheet } from '../../pim/studio-sheet.service.js'
import { marketLanguages, type MarketLanguageRow } from '../../pim/market-languages.js'
import { effectiveGlossary, glossaryHits, listTerminology } from '../../ai/terminology.service.js'
import {
  applyProductBulkEdits,
  ProductBulkError,
  type ProductBulkChangeError,
  type ProductBulkChangeWarning,
  type ProductBulkContext,
  type ProductBulkInput,
} from '../../products/bulk-edit.service.js'
import { logger } from '../../../utils/logger.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { writeTranslation } from '../../pim/translation-write.js'

/** The provenance stamped on a translation row Claude wrote and a person approved (d8). */
export const CLAUDE_SOURCE_MODEL = 'claude-mcp'
const TEXT_FIELDS = ['title', 'description', 'bulletPoints', 'keywords'] as const
type TextField = (typeof TEXT_FIELDS)[number]
const LIST_FIELDS = new Set(['bulletPoints', 'keywords'])
const MAX_ATTRIBUTES = 20
const MAX_BULLETS = 10
const MAX_KEYWORDS = 50
/** Listings named per field in `reach`; the rest are counted. */
const REACH_NAMES = 25
const ATTRIBUTE_CODE = /^[a-z][a-z0-9_]{0,99}$/i
/** The meaning an undo carries: the old text's English meaning was never recorded. */
const UNDO_MEANING = 'Undo: puts back the text this field had before the change. No English meaning was recorded for that text.'

type Change = ProductBulkInput['changes'][number]
type Refusal = { error: string }
const has = (bag: unknown, key: string) => !!bag && typeof bag === 'object' && Object.prototype.hasOwnProperty.call(bag, key)
const present = (value: unknown) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const listed = (items: string[], cap = 10) => (items.length > cap ? `${items.slice(0, cap).join(', ')} and ${items.length - cap} more` : items.join(', '))
const isTextField = (field: string): field is TextField => (TEXT_FIELDS as readonly string[]).includes(field)
/** A value that carries text a person must read in English: a non-empty text, or a list / object holding one. */
const hasText = (value: unknown): boolean => typeof value === 'string' ? value.trim() !== ''
  : Array.isArray(value) ? value.some(hasText)
  : !!value && typeof value === 'object' ? Object.values(value).some(hasText) : false

// ── The product writer, as these tools call it ─────────────────────────────────────────────────────────

/** Nexus only (d7) and stamped as Claude's text a person approved (d8). It logs as pino does; Nexus's logger takes (message, details). */
export function contentWriterContext(userId: string | null | undefined, tool: string): ProductBulkContext {
  const log = (level: 'warn' | 'error') => (details: unknown, message?: string) =>
    logger[level](message ?? `[agents/${tool}] product writer`, { details })
  return {
    formulaCascade: false,
    userId: userId ?? null,
    queueOutbound: false,
    contentProvenance: { sourceModel: CLAUDE_SOURCE_MODEL, reason: `mcp:${tool}` },
    logger: { warn: log('warn'), error: log('error') } as unknown as ProductBulkContext['logger'],
  }
}

type WriterOutcome = { errors?: ProductBulkChangeError[]; warnings?: ProductBulkChangeWarning[]; validated?: number; wouldUpdate?: number }

/** The writer's verdict (a dry run writes nothing) or its refusal in a sentence. A throw rolls its transaction back. */
export async function runContentWriter(
  input: ProductBulkInput,
  context: ProductBulkContext,
  labelOf: (change: { id: string; field: string }) => string,
): Promise<{ refusal: string } | { warnings: string[] }> {
  const lines = (rows: Array<{ id: string; field: string; error?: string; warning?: string }>) =>
    rows.map((row) => `${labelOf(row)}: ${row.error ?? row.warning}`)
  try {
    const out = (await applyProductBulkEdits(input, context)) as WriterOutcome
    if (out.errors?.length) return { refusal: `The product writer refused it: ${listed(lines(out.errors))}` }
    return { warnings: lines(out.warnings ?? []).sort() }
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    const errors = error.details.errors
    return { refusal: Array.isArray(errors) && errors.length ? `The product writer refused it: ${listed(lines(errors as ProductBulkChangeError[]))}` : error.message }
  }
}

// ── Reading a product's shared text at one tier ────────────────────────────────────────────────────────

const PRODUCT_CONTENT_SELECT = {
  id: true, sku: true, parentId: true, workspaceId: true, version: true, brand: true, familyId: true,
  name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, variantAttributes: true,
  translations: true,
} as const

export async function contentProduct(id: string) {
  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { ...PRODUCT_CONTENT_SELECT, parent: { select: PRODUCT_CONTENT_SELECT } },
  })
  return product
}
type ContentRow = NonNullable<Awaited<ReturnType<typeof contentProduct>>>
type OwnTranslation = ContentRow['translations'][number]

/** What one tier stores for a field: `{ value }`, or null when it stores nothing there and the field falls back. */
export type Own = { value: unknown } | null

/** The writer's field for a content field. */
const writerField = (field: string) => (isTextField(field) ? (field === 'title' ? 'name' : field) : `attr_${field}`)

/**
 * The field's own value at a tier, as the resolver reads it (`content-resolver.ts` translationValue): the source tier
 * is the product's column or attribute; the language tier is the translation row's, where an explicit clear counts.
 */
export function ownValue(product: Pick<ContentRow, 'name' | 'description' | 'bulletPoints' | 'keywords' | 'categoryAttributes' | 'translations'>, field: string, tier: 'source' | 'language', language: string): Own {
  const column = CONTENT_COLUMNS[field as TextField]
  if (tier === 'source') {
    const value = column ? (product as Record<string, unknown>)[column] : (product.categoryAttributes as Record<string, unknown> | null)?.[field]
    return { value: value ?? null }
  }
  const row = product.translations.find((t) => t.language === language) as OwnTranslation | undefined
  if (!row) return null
  if (has(row.attributes, field)) return { value: (row.attributes as Record<string, unknown>)[field] }
  const value = column ? (row as Record<string, unknown>)[column] : (row.attributes as Record<string, unknown> | null)?.[field]
  return present(value) ? { value } : null
}

/** The product with the field dropped from its `language` row: what a reset would leave it showing. */
function withoutOwn(product: ContentRow, field: string, language: string): ContentRow {
  const column = CONTENT_COLUMNS[field as TextField]
  return {
    ...product,
    translations: product.translations.map((row) => {
      if (row.language !== language) return row
      const attributes = { ...((row.attributes as Record<string, unknown> | null) ?? {}) }
      delete attributes[field]
      return { ...row, attributes, ...(column ? { [column]: LIST_FIELDS.has(field) ? [] : null } : {}) } as OwnTranslation
    }),
  }
}

// ── reach: the listings a shared change shows on ───────────────────────────────────────────────────────

export interface Reach { follow: string[]; ownPin: string[]; moreFollow?: number; moreOwnPin?: number }

/**
 * Per field, the listings carrying this language that show this product's shared text: those that follow it (the
 * product's own listings, and its variations' when they inherit the field from it) and those that keep their own pin.
 */
async function reachOf(product: ContentRow, fields: string[], language: string): Promise<Record<string, Reach>> {
  const children = await prisma.product.findMany({
    where: { parentId: product.id, deletedAt: null },
    select: { ...PRODUCT_CONTENT_SELECT },
    orderBy: { sku: 'asc' },
  })
  const productIds = [product.id, ...children.map((c) => c.id)]
  const [listings, markets] = await Promise.all([
    prisma.channelListing.findMany({
      where: { productId: { in: productIds } },
      include: { translations: true, product: { select: { sku: true } } },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { id: 'asc' }],
    }),
    prisma.marketplace.findMany({ select: { channel: true, code: true, languages: true, language: true } }),
  ])
  const languagesOf = (channel: string, market: string) => {
    try {
      return marketLanguages(channel, market, markets as MarketLanguageRow[])
    } catch {
      return []
    }
  }
  const out: Record<string, Reach> = {}
  const tier = language === primaryLanguage() ? 'source' : 'language'
  for (const field of fields) {
    // A variation shows this product's text for the field unless it holds its own at this tier (the resolver reads a
    // variation's own text first, then its parent's) — judged on what it stores, so it also holds after the write.
    const inherits = new Set([product.id, ...children.filter((child) => {
      const own = ownValue(child, field, tier, language)
      return !own || !present(own.value)
    }).map((child) => child.id)])
    const follow: string[] = []
    const ownPin: string[] = []
    for (const listing of listings) {
      if (!inherits.has(listing.productId)) continue
      const languages = languagesOf(listing.channel, listing.marketplace)
      if (!languages.includes(language)) continue
      const label = `${channelLabel(listing.channel)} · ${listing.marketplace} · ${listing.product.sku}${listing.aliasKey ? ` (${listing.aliasKey})` : ''}`
      ;(listingFollowsContent(listing, field, language, languages) ? follow : ownPin).push(label)
    }
    follow.sort()
    ownPin.sort()
    out[field] = {
      follow: follow.slice(0, REACH_NAMES), ownPin: ownPin.slice(0, REACH_NAMES),
      ...(follow.length > REACH_NAMES ? { moreFollow: follow.length - REACH_NAMES } : {}),
      ...(ownPin.length > REACH_NAMES ? { moreOwnPin: ownPin.length - REACH_NAMES } : {}),
    }
  }
  return out
}

// ── The plan: one product, one language, the shared layer ──────────────────────────────────────────────

export interface FieldPlan {
  field: string
  reset: boolean
  /** The new value; null for a reset. */
  to: unknown
  /** What the field shows in this language now (another language's text when it falls back: `fromLanguage`). */
  from: unknown
  fromLanguage?: string
  fromParent?: boolean
  /** A reset: what the field shows afterwards. */
  thenShows?: unknown
  thenShowsLanguage?: string
  /** What this tier stores now. */
  own: Own
  englishMeaning?: string
}

export interface SharedPlan {
  product: ContentRow
  language: string
  tier: 'source' | 'language'
  address: ContentAddress
  /** The language row's version (0: none yet); null on the source tier. */
  translationVersion: number | null
  fields: FieldPlan[]
  unchanged: string[]
  localizableKeys: string[]
}

export interface SharedRequest {
  product: string
  language: string
  set: Record<string, unknown>
  reset: string[]
  englishMeaning: Record<string, string>
}

/** The fields a request sets: the text fields given, then the attributes. */
export function requestedSets(args: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  for (const field of TEXT_FIELDS) {
    const raw = args[field]
    if (raw === undefined) continue
    set[field] = LIST_FIELDS.has(field) ? (Array.isArray(raw) ? raw.map(String) : raw) : raw == null ? raw : String(raw)
  }
  const attributes = args.attributes
  // In code order: a stored approval's arguments come back from jsonb with their keys re-ordered, and the plan (its
  // basis) must not depend on the order a caller wrote them in.
  if (attributes && typeof attributes === 'object') {
    for (const [code, value] of Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))) set[code] = value == null ? value : String(value)
  }
  return set
}

/**
 * Work out a shared-layer change from what is stored NOW. All or nothing: any field that cannot change refuses it.
 * `nothing` ends every refusal ("Nothing was changed." / "Nothing was queued.").
 */
export async function planSharedContent(request: SharedRequest, nothing: string): Promise<SharedPlan | Refusal> {
  const named = await liveProductByRef(request.product)
  if (!named) return { error: PRODUCT_NOT_FOUND }
  const parsed = languageOf(request.language)
  if ('error' in parsed) return { error: `${parsed.error} ${nothing}` }
  const language = parsed.language
  const tier = language === primaryLanguage() ? 'source' : 'language'
  const sets = Object.keys(request.set)
  const resets = [...new Set(request.reset)]
  if (!sets.length && !resets.length) {
    return { error: `Name what to change: title, bulletPoints, description, keywords, attributes or reset. ${nothing}` }
  }
  if (resets.length && tier === 'source') {
    return { error: `reset drops a language's own text so it shows the ${language} source text again; ${language} is the source itself — send the text instead. ${nothing}` }
  }
  const both = resets.filter((field) => sets.includes(field))
  if (both.length) return { error: `${listed(both)} cannot be set and reset in one change. ${nothing}` }
  for (const field of sets) {
    const value = request.set[field]
    if (LIST_FIELDS.has(field) ? !Array.isArray(value) : typeof value !== 'string' && value !== null) {
      return { error: `${field} needs ${LIST_FIELDS.has(field) ? 'a list of texts' : 'a text, or null for no value'}. ${nothing}` }
    }
  }

  // Attributes: only translatable text of the family dictionary (the sheet's rule: localizable and not a choice list).
  const codes = [...sets, ...resets].filter((field) => !isTextField(field))
  const badCodes = codes.filter((code) => !ATTRIBUTE_CODE.test(code))
  if (badCodes.length) return { error: `${listed(badCodes)}: not a field this tool knows — title, description, bulletPoints, keywords, or an attribute code. ${nothing}` }
  if (codes.length) {
    const translatable = await prisma.customAttribute.findMany({
      where: { code: { in: codes }, localizable: true, archivedAt: null, type: { notIn: ['select', 'multiselect'] } },
      select: { code: true },
    })
    const known = new Set(translatable.map((row) => row.code))
    const not = codes.filter((code) => !known.has(code))
    if (not.length) {
      return {
        error: `${listed(not)} ${not.length === 1 ? 'is' : 'are'} not translatable text of the business's attributes, so this tool cannot `
          + `set ${not.length === 1 ? 'it' : 'them'} per language. An attribute kept once for every language is changed with bulk-attribute-change. ${nothing}`,
      }
    }
  }

  const product = await contentProduct(named.id)
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const parent = (product.parent ?? null) as unknown as ContentProduct | null
  const localizableKeys = codes
  const resolve = (row: ContentRow, field: string) =>
    resolveContent({ product: row as unknown as ContentProduct, parent, field, localizableKeys, address: { requested: language } })
  const fields: FieldPlan[] = []
  const unchanged: string[] = []
  for (const field of [...sets, ...resets]) {
    const reset = resets.includes(field)
    const own = ownValue(product, field, tier, language)
    const to = reset ? null : request.set[field]
    if (reset ? own === null : own !== null && same(own.value, to)) {
      unchanged.push(field)
      continue
    }
    const now = resolve(product, field)
    const plan: FieldPlan = { field, reset, to, from: now.value, own }
    if (now.language !== language) plan.fromLanguage = now.language
    if (now.ownerId && now.ownerId !== product.id) plan.fromParent = true
    if (reset) {
      const after = resolve(withoutOwn(product, field, language), field)
      plan.thenShows = after.value
      if (after.language !== language) plan.thenShowsLanguage = after.language
    }
    fields.push(plan)
  }
  if (!fields.length) {
    return { error: `Nothing to change: ${listed(unchanged)} already ${unchanged.length === 1 ? 'says' : 'say'} that in ${language}. ${nothing}` }
  }

  // The English meaning of every new text, for the person who approves it (they read English).
  const meaningKeys = Object.keys(request.englishMeaning)
  const stray = meaningKeys.filter((key) => !sets.includes(key))
  if (stray.length) return { error: `englishMeaning names ${listed(stray)}, which this change does not set. ${nothing}` }
  if (language !== 'en') {
    // A field set to no value (null, an empty list) has no text to translate.
    const without = fields.filter((f) => !f.reset && hasText(f.to) && !request.englishMeaning[f.field]?.trim()).map((f) => f.field)
    if (without.length) {
      return { error: `englishMeaning is required for ${listed(without)}: what the new ${language} text says in English, for the person who approves it. ${nothing}` }
    }
  }
  for (const f of fields) if (request.englishMeaning[f.field]) f.englishMeaning = request.englishMeaning[f.field]

  const translationVersion = tier === 'language' ? product.translations.find((row) => row.language === language)?.version ?? 0 : null
  const address: ContentAddress = tier === 'source' ? { tier: 'source' } : { tier: 'language', language }
  return { product, language, tier, address, translationVersion, fields, unchanged, localizableKeys }
}

/** The writer's changes for a plan. */
export function sharedWrites(plan: SharedPlan): Change[] {
  return plan.fields.map((f) => ({
    id: plan.product.id,
    field: writerField(f.field),
    value: f.reset ? null : f.to,
    contentAddress: plan.address,
    contentState: 'reviewed' as const,
    ...(f.reset ? { intent: 'reset' as const } : {}),
    ...(plan.translationVersion !== null ? { contentVersion: plan.translationVersion } : {}),
  }))
}

/** What the person reads per field: from → to, and the English meaning. */
export function sharedChanges(plan: SharedPlan) {
  return Object.fromEntries(plan.fields.map((f) => [f.field, {
    from: f.from,
    ...(f.fromLanguage ? { fromLanguage: f.fromLanguage } : {}),
    ...(f.fromParent ? { fromParent: true } : {}),
    to: f.to,
    ...(f.reset ? { reset: true, thenShows: f.thenShows ?? null, ...(f.thenShowsLanguage ? { thenShowsLanguage: f.thenShowsLanguage } : {}) } : {}),
    ...(f.englishMeaning ? { englishMeaning: f.englishMeaning } : {}),
  }]))
}

/** Everything the preview was worked out from that `changes` does not show: what each field stores at this tier, and the row's version. */
export const sharedBasis = (plan: SharedPlan) =>
  basisOf({ product: plan.product.id, language: plan.language, tier: plan.tier, version: plan.translationVersion, own: plan.fields.map((f) => [f.field, f.own]) })

export interface GlossaryFinding { sku?: string; field: string; avoid: string; use: string; context: string | null }

/** The glossary's avoid words in new texts, for a brand in one language (one finding per field and word). */
export async function glossaryFindings(brand: string | null, language: string, texts: Array<{ sku?: string; field: string; value: unknown }>): Promise<GlossaryFinding[]> {
  const written = texts.filter((t) => t.value != null && t.value !== '')
  if (!written.length) return []
  const rows = await listTerminology({ brand: brand ?? '__none__', language })
  const effective = effectiveGlossary(rows, brand)
  const seen = new Set<string>()
  const hits: GlossaryFinding[] = []
  for (const t of written) {
    for (const hit of glossaryHits(Array.isArray(t.value) ? (t.value as string[]) : String(t.value), effective)) {
      const key = `${t.sku ?? ''}|${t.field}|${hit.avoid.toLowerCase()}|${hit.use.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ ...(t.sku ? { sku: t.sku } : {}), field: t.field, avoid: hit.avoid, use: hit.use, context: hit.context })
    }
  }
  return hits
}

/** The glossary's avoid words in a shared plan's new text, for the product's brand in this language. */
export function glossaryHitsFor(plan: SharedPlan, sku?: string) {
  const brand = plan.product.brand ?? plan.product.parent?.brand ?? null
  return glossaryFindings(brand, plan.language, plan.fields.filter((f) => !f.reset).map((f) => ({ ...(sku ? { sku } : {}), field: f.field, value: f.to })))
}

/** What the fields store at the plan's tier now, for the change record and its undo. */
export function ownFields(product: ContentRow, fields: string[], tier: 'source' | 'language', language: string): Record<string, Own> {
  return Object.fromEntries(fields.map((field) => [field, ownValue(product, field, tier, language)]))
}

/** Thrown inside a write's transaction to roll it back; the caller answers with its sentence. */
class ContentRefused extends Error {}

/** A text stored nowhere: no value, an empty text, an empty list. */
const blank = (value: unknown) => value == null || value === '' || (Array.isArray(value) && value.length === 0)

/**
 * A language row a reset left with nothing of its own is removed: a language with no text of its own has no row
 * (an own EMPTY value is kept in `attributes`, so it keeps the row). This is what puts back "no row" when an undo
 * resets the fields of the change that created the row — the 2026-10-02 end-to-end run found the undo of a set-content
 * in en leaving an empty en row behind. Through the translation writer's own removal: versioned, audited as the
 * person (reason mcp:<tool>), cascaded with no channel update. Runs in the caller's transaction.
 */
async function dropEmptyLanguageRow(plan: SharedPlan, userId: string | null | undefined, tool: string): Promise<boolean> {
  if (plan.tier !== 'language' || !plan.fields.some((f) => f.reset)) return false
  const row = await prisma.productTranslation.findFirst({ where: { productId: plan.product.id, language: plan.language } })
  if (!row) return false
  const stored = row as unknown as Record<string, unknown>
  const holdsText = Object.values(CONTENT_COLUMNS).some((column) => !blank(stored[column]))
    || Object.keys((row.attributes ?? {}) as Record<string, unknown>).length > 0
  if (holdsText) return false
  await writeTranslation({
    productId: plan.product.id, locale: plan.language, address: plan.address, values: {}, state: 'reviewed', remove: true,
    expectedTranslationVersion: row.version, userId: userId ?? null, label: 'Translation', queueOutbound: false, reason: `mcp:${tool}`,
  })
  return true
}

// ── set-content ────────────────────────────────────────────────────────────────────────────────────────

const setContentInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product: a Nexus product id or a SKU'),
  language: languageArg.describe('the language of the text, e.g. it or de: the primary language (it) changes the source text, any other the shared text in that language'),
  title: z.string().max(1000).nullable().optional().describe('new title'),
  bulletPoints: z.array(z.string().max(2000)).max(MAX_BULLETS).optional().describe(`new bullet points, at most ${MAX_BULLETS}`),
  description: z.string().max(20_000).nullable().optional().describe('new description, or null for none'),
  keywords: z.array(z.string().max(500)).max(MAX_KEYWORDS).optional().describe(`new search keywords, at most ${MAX_KEYWORDS}`),
  attributes: z.record(z.string().regex(ATTRIBUTE_CODE), z.string().max(5000).nullable()).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES, { message: `at most ${MAX_ATTRIBUTES} attributes` })
    .describe(`translatable text attributes of the product, by code: { code: text }, at most ${MAX_ATTRIBUTES}`),
  reset: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_ATTRIBUTES + TEXT_FIELDS.length).optional()
    .describe('fields to drop from this language so they show the source text again (not for the primary language): title, description, bulletPoints, keywords or an attribute code'),
  englishMeaning: z.record(z.string().trim().min(1).max(100), z.string().max(20_000)).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES + TEXT_FIELDS.length, { message: 'too many fields' })
    .describe('per field set, what the new text says in English, for the person who approves it: required for every field set unless the language is en'),
})

const NOTHING = 'Nothing was queued.'
const NOTHING_WRITTEN = 'Nothing was changed.'

function sharedRequest(args: Record<string, unknown>): SharedRequest {
  return {
    product: String(args.product ?? ''),
    language: String(args.language ?? ''),
    set: requestedSets(args),
    reset: Array.isArray(args.reset) ? args.reset.map(String) : [],
    englishMeaning: (args.englishMeaning && typeof args.englishMeaning === 'object' ? args.englishMeaning : {}) as Record<string, string>,
  }
}

/** C2 — undo of set-content: a new set-content that puts back what each field stored (or drops what it did not). */
export const SET_CONTENT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; language?: string; tier?: 'source' | 'language'; fields?: Record<string, Own> }
    const product = after.productId ? await contentProduct(after.productId) : null
    const fields = Object.keys(after.fields ?? {})
    return {
      productId: after.productId, language: after.language, tier: after.tier,
      fields: product ? ownFields(product, fields, after.tier ?? 'source', after.language ?? '') : Object.fromEntries(fields.map((f) => [f, 'product not found'])),
    }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: unknown; language?: unknown; tier?: unknown; fields?: Record<string, Own> }
    if (typeof before.productId !== 'string' || typeof before.language !== 'string') return { refusal: 'This change does not name its product and language.' }
    const fields = undoFieldArgs(before.fields ?? {})
    return Object.keys(fields).length ? { tool: 'set-content', args: { product: before.productId, language: before.language, ...fields } } : { refusal: 'This change named no field.' }
  },
}

/** The set-content arguments that put back what each field stored: its text, or a reset where it stored none. */
function undoFieldArgs(fields: Record<string, Own>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const reset: string[] = []
  const attributes: Record<string, string | null> = {}
  const englishMeaning: Record<string, string> = {}
  for (const [field, own] of Object.entries(fields)) {
    if (own === null) {
      reset.push(field)
      continue
    }
    // Exactly what it stored: no value stays no value (null), never an empty text.
    const value = own.value
    if (isTextField(field)) args[field] = LIST_FIELDS.has(field) ? (Array.isArray(value) ? value.map(String) : []) : value == null ? null : String(value)
    else attributes[field] = value == null ? null : String(value)
    if (hasText(args[field] ?? attributes[field])) englishMeaning[field] = UNDO_MEANING
  }
  if (Object.keys(attributes).length) args.attributes = attributes
  if (reset.length) args.reset = reset
  if (Object.keys(englishMeaning).length) args.englishMeaning = englishMeaning
  return args
}

const setContent: AgentTool = {
  name: 'set-content',
  title: 'Set product text',
  input: setContentInput,
  requires: [F.productsEdit, F.productsTranslationsEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  // d8: the person's Approve in Nexus is the review of the text, so a person always approves it there.
  maxClaudeTrust: 'ask',
  undo: SET_CONTENT_UNDO,
  description:
    'Change one product\'s shared text in one language — title, bullet points, description, keywords, translatable '
    + 'attributes — or drop a language\'s own text so it shows the source again (reset). The primary language (it) is the '
    + 'source text; any other language is the shared text every listing in that language follows unless it keeps its own '
    + 'pin. Give englishMeaning for every field you set unless the language is en: the person who approves reads it. The '
    + 'preview shows from → to, the writer\'s warnings, the glossary\'s avoid words found, and reach (listings that follow '
    + 'this text, and those with their own pin). A person approves it in Nexus, and the approval is its review. Saved in '
    + 'Nexus only: the channels change when the listings are published from Nexus. Read content-guidelines first.',
  async handler(args): Promise<ToolResult> {
    const plan = await planSharedContent(sharedRequest(args), NOTHING)
    if ('error' in plan) return { ok: false, error: plan.error }
    const checked = await runContentWriter({ changes: sharedWrites(plan), dryRun: true }, contentWriterContext(null, 'set-content'), (row) => row.field.replace(/^attr_/, ''))
    if ('refusal' in checked) return { ok: false, error: `${checked.refusal.replace(/[.\s]+$/, '')}. ${NOTHING}` }
    const [reach, hits] = await Promise.all([
      reachOf(plan.product, plan.fields.map((f) => f.field), plan.language),
      glossaryHitsFor(plan),
    ])
    return {
      ok: true,
      preview: {
        action: 'set-content',
        productId: plan.product.id,
        sku: plan.product.sku,
        language: plan.language,
        layer: plan.tier === 'source' ? 'source' : 'language',
        changes: sharedChanges(plan),
        reach,
        basis: sharedBasis(plan),
        ...(plan.unchanged.length ? { unchanged: plan.unchanged } : {}),
        ...(checked.warnings.length ? { warnings: checked.warnings } : {}),
        ...(hits.length ? { glossaryHits: hits } : {}),
        note: `${NEXUS_ONLY} Saved as reviewed text: approving it is its review. The English meaning is Claude's own reading of the new text.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planSharedContent(sharedRequest(args), NOTHING_WRITTEN)
    if ('error' in plan) return { ok: false, error: plan.error }
    const fields = plan.fields.map((f) => f.field)
    try {
      // One transaction: the write, and the removal of a language row it leaves with nothing (dropEmptyLanguageRow).
      return await inDatabaseTransaction(prisma, async () => {
        // Guarded by the versions just read: the change record below is exactly what this write replaces.
        const written = await runContentWriter(
          { changes: sharedWrites(plan), expectedVersion: plan.product.version },
          contentWriterContext(ctx.userId, 'set-content'),
          (row) => row.field.replace(/^attr_/, ''),
        )
        if ('refusal' in written) throw new ContentRefused(written.refusal)
        const removedRow = await dropEmptyLanguageRow(plan, ctx.userId, 'set-content')
        const now = await contentProduct(plan.product.id)
        const record = (fieldsOwn: Record<string, Own>) => ({ productId: plan.product.id, language: plan.language, tier: plan.tier, fields: fieldsOwn })
        return {
          ok: true,
          data: {
            productId: plan.product.id, sku: plan.product.sku, language: plan.language, applied: fields,
            ...(removedRow ? { removedLanguageRow: true } : {}),
            ...(written.warnings.length ? { warnings: written.warnings } : {}),
          },
          change: {
            before: record(Object.fromEntries(plan.fields.map((f) => [f.field, f.own]))),
            after: record(now ? ownFields(now, fields, plan.tier, plan.language) : {}),
          },
        }
      })
    } catch (error) {
      if (error instanceof ContentRefused) return { ok: false, error: `${error.message.replace(/[.\s]+$/, '')}. ${NOTHING_WRITTEN}` }
      throw error
    }
  },
}


// ── set-listing-content ────────────────────────────────────────────────────────────────────────────────

const upperText = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)

/** A channel attribute's value as the listing stores it: kept with its JSON type, so an undo puts back exactly that. */
const ATTRIBUTE_SCALAR = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])
const ATTRIBUTE_VALUE = z.union([
  ATTRIBUTE_SCALAR,
  z.array(ATTRIBUTE_SCALAR).max(250),
  z.record(z.string().max(100), ATTRIBUTE_SCALAR),
])

const setListingContentInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product whose listing it is: a Nexus product id or a SKU (a parent or a variation)'),
  coordinate: z.object({
    channel: z.preprocess(upperText, z.enum(COORDINATE_CHANNELS)).describe('AMAZON, EBAY or ETSY (a Shopify listing: set-shopify-content)'),
    market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Etsy'),
    accountId: z.string().trim().min(1).max(64).optional().describe('the channel account, when the business has more than one'),
    aliasKey: z.string().trim().min(1).max(64).optional().describe('a second listing of the product on this coordinate (its alias key)'),
  }).describe('the one listing: channel + market'),
  language: languageArg.describe("the language of the text: one of the market's languages"),
  pin: z.object({
    title: z.string().max(1000).nullable().optional().describe("this listing's own title (null: its own empty title)"),
    description: z.string().max(20_000).nullable().optional().describe("this listing's own description (null: its own empty description)"),
    bulletPoints: z.array(z.string().max(2000)).max(MAX_BULLETS).optional().describe(`this listing's own bullet points, at most ${MAX_BULLETS}`),
    keywords: z.array(z.string().max(500)).max(MAX_KEYWORDS).optional().describe(`this listing's own search keywords, at most ${MAX_KEYWORDS}`),
  }).optional().describe("text this listing keeps as its own, instead of the shared text"),
  follow: z.array(z.enum(TEXT_FIELDS)).min(1).max(TEXT_FIELDS.length).optional()
    .describe("fields this listing stops keeping as its own: they show the shared text again"),
  attributes: z.record(z.string().trim().min(1).max(100), ATTRIBUTE_VALUE).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES, { message: `at most ${MAX_ATTRIBUTES} attributes` })
    .describe(`this listing's own channel attributes (Amazon attributes, eBay item specifics, Etsy attributes) by key: { key: value } — a text, number, true/false, a list, a { value, unit } measure, or null for an empty value; at most ${MAX_ATTRIBUTES}`),
  dropAttributes: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_ATTRIBUTES).optional()
    .describe("channel attributes this listing stops keeping its own value for: they take the value the listing inherits again"),
  englishMeaning: z.record(z.string().trim().min(1).max(100), z.string().max(20_000)).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES + TEXT_FIELDS.length, { message: 'too many fields' })
    .describe('per field or attribute set, what the new text says in English, for the person who approves it: required unless the language is en'),
})

type ListingRow = NonNullable<Awaited<ReturnType<typeof findListing>>>

async function findListing(productId: string, channel: string, market: string, accountId: string | undefined, aliasKey: string) {
  const rows = await prisma.channelListing.findMany({
    where: { productId, channel, marketplace: market, ...(accountId ? { channelConnectionId: accountId } : {}), aliasKey },
    include: { translations: true },
  })
  return rows.length === 1 ? rows[0] : rows.length ? ('many' as const) : null
}

type ListingKind = 'pin' | 'follow' | 'attribute'
interface ListingFieldPlan {
  field: string
  kind: ListingKind
  /** The writer's change, but for its address and version (set when the plan is written). */
  writerField: string
  column: SheetColumn
  to: unknown
  /** What the listing shows now. */
  from: unknown
  /** What the listing keeps as its own now: a pin's text, an attribute's stored value; null when it keeps none. */
  own: Own
  /** An attribute: where the listing stores it (the channel's store for this column), read again by the undo. */
  store?: ChannelStoreRef
  /** An attribute the listing stops keeping its own value for. */
  drop?: boolean
  englishMeaning?: string
}
type ChannelStoreRef = ReturnType<typeof storeOf>
interface ListingPlan {
  product: { id: string; sku: string; brand: string | null }
  listing: Exclude<ListingRow, 'many'>
  label: string
  language: string
  coordinate: { channel: string; market: string; accountId: string | null; aliasKey: string }
  pinAddress: ContentAddress | null
  pinVersion: number
  fields: ListingFieldPlan[]
  unchanged: string[]
}

/** What a listing keeps as its own text for a field: the resolver's pin (its own row, or a legacy pin), else null. */
function ownPin(product: ContentRow, listing: Exclude<ListingRow, 'many'>, coordinate: ListingPlan['coordinate'], languages: string[], field: string, language: string): Own {
  const hydrated = contentListing(product, listing, { channel: coordinate.channel, market: coordinate.market,
    ...(coordinate.accountId ? { accountId: coordinate.accountId } : {}), ...(coordinate.aliasKey ? { aliasId: coordinate.aliasKey } : {}) }, languages)
  const resolved = resolveContent({ product: product as unknown as ContentProduct, parent: (product.parent ?? null) as unknown as ContentProduct | null,
    listing: hydrated, field, address: { requested: language, coordinate: hydrated!.coordinate } })
  return resolved.tier === 'pin' && resolved.follows === false ? { value: resolved.value } : null
}

function storeOf(column: SheetColumn, label: string, productType: string | null) {
  const facts = column.channels?.[label]
  return facts?.byCategory?.[productType ?? '']?.store ?? facts?.store
}

/** Work out a listing's own-text change from what is stored NOW. All or nothing. */
async function planListingContent(args: Record<string, unknown>, nothing: string): Promise<ListingPlan | Refusal> {
  const named = await liveProductByRef(String(args.product ?? ''))
  if (!named) return { error: PRODUCT_NOT_FOUND }
  const c = args.coordinate as { channel: string; market: string; accountId?: string; aliasKey?: string }
  const elsewhere = channelNotHere(c.channel, 'A Shopify listing\'s store fields (metafields, vendor, tags, SEO) are changed with set-shopify-content; '
    + 'its title and description follow the shared text (set-content) — a Shopify-only text is not available to Claude yet.')
  if (elsewhere) return { error: `${elsewhere} ${nothing}` }
  const parsed = languageOf(String(args.language ?? ''))
  if ('error' in parsed) return { error: `${parsed.error} ${nothing}` }
  const language = parsed.language
  const pin = (args.pin && typeof args.pin === 'object' ? args.pin : {}) as Record<string, unknown>
  const pins = TEXT_FIELDS.filter((field) => pin[field] !== undefined)
  const follow = [...new Set(Array.isArray(args.follow) ? (args.follow as string[]) : [])]
  const attributes = (args.attributes && typeof args.attributes === 'object' ? args.attributes : {}) as Record<string, unknown>
  const drops = [...new Set(Array.isArray(args.dropAttributes) ? (args.dropAttributes as string[]) : [])]
  // In key order: a stored approval's arguments come back from jsonb with their keys re-ordered (see requestedSets).
  const codes = [...new Set([...Object.keys(attributes), ...drops])].sort((a, b) => a.localeCompare(b))
  const setAndDropped = drops.filter((code) => code in attributes)
  if (setAndDropped.length) return { error: `${listed(setAndDropped)} cannot be set and dropped in one change. ${nothing}` }
  if (!pins.length && !follow.length && !codes.length) return { error: `Name what to change: pin, follow, attributes or dropAttributes. ${nothing}` }
  const both = follow.filter((field) => pins.includes(field as TextField))
  if (both.length) return { error: `${listed(both)} cannot be pinned and returned to the shared text in one change. ${nothing}` }

  const channelName = channelLabel(c.channel)
  const where = `${channelName} · ${c.market}`
  let languages: string[]
  try {
    languages = await marketLanguages(c.channel, c.market)
  } catch (error) {
    return { error: `${error instanceof Error ? error.message : `${where} has no languages configured.`} ${nothing}` }
  }
  if (!languages.includes(language)) {
    return { error: `${language} is not a language of ${where}: it carries ${languages.join(', ')}. A listing keeps its own text only in its market's languages; the shared ${language} text is changed with set-content. ${nothing}` }
  }
  const aliasKey = c.aliasKey ?? ''
  const listing = await findListing(named.id, c.channel, c.market, c.accountId, aliasKey)
  if (listing === 'many') return { error: `${named.sku} has listings on ${where} under more than one account: name the account (coordinate.accountId). ${nothing}` }
  if (!listing) {
    return { error: `${named.sku} has no ${where} listing${aliasKey ? ` "${aliasKey}"` : ''} yet: create the listing first, then give it its own text. ${nothing}` }
  }
  const product = await contentProduct(named.id)
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const coordinate = { channel: c.channel, market: c.market, accountId: listing.channelConnectionId ?? null, aliasKey }

  // The product sheet's own read of this listing: which cells exist, whether each can be edited, and why not.
  let sheet: StudioSheet
  try {
    const { getInformationSheet } = await import('../../pim/information-sheet.js')
    sheet = await getInformationSheet({ productId: named.id, scope: 'channel', channel: c.channel, market: c.market, locale: language,
      ...(listing.channelConnectionId ? { accountId: listing.channelConnectionId } : {}) })
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown }
    if (e?.code === 'unknown_product') return { error: PRODUCT_NOT_FOUND }
    if (typeof e?.code === 'string' && typeof e.message === 'string' && ['scope_not_available', 'unknown_market'].includes(e.code)) return { error: `${e.message} ${nothing}` }
    throw error
  }
  const row: StudioRow | undefined = sheet.rows.find((r) => r.id === named.id && (r.aliasId ?? '') === aliasKey)
  if (!row) return { error: `${named.sku} has no ${where} listing in the product sheet. ${nothing}` }
  // The sheet addresses a coordinate's listings by account. A legacy listing with no account is not the one it shows
  // when the business has an account on this channel, so no cell of the sheet can write it (the writer would refuse
  // its address): say what fixes it instead.
  if ((row.listing?.id ?? null) !== listing.id) {
    return { error: listing.channelConnectionId
      ? `Not possible on ${where} · ${named.sku}: the product sheet shows another listing on this coordinate; name its account (coordinate.accountId). ${nothing}`
      : `Not possible on ${where} · ${named.sku}: this listing has no channel account — link it to the ${channelName} account first, then ask again. ${nothing}` }
  }
  const cellOf = (column: SheetColumn): StudioCellValue | undefined => row.values[column.key]
  const contentColumns = (field: string) => sheet.columns.filter((column) => isLocalizableContent(column.slot?.of ?? column.key, column.storage)
    && contentField(column.slot?.of ?? column.key) === field).sort((a, b) => (a.slot?.index ?? 0) - (b.slot?.index ?? 0))
  const blocked = (columns: SheetColumn[]) => columns.map(cellOf).find((cell) => cell && !cell.editable)
  const shownValue = (columns: SheetColumn[]) => columns[0]?.slot
    ? (() => { const items = columns.map((col) => cellOf(col)?.value ?? null); while (items.length && (items[items.length - 1] == null || items[items.length - 1] === '')) items.pop(); return items })()
    : cellOf(columns[0])?.value ?? null

  const fields: ListingFieldPlan[] = []
  const unchanged: string[] = []
  const refusals: string[] = []
  let pinAddress: ContentAddress | null = null
  for (const field of [...pins, ...follow]) {
    const columns = contentColumns(field)
    if (!columns.length) { refusals.push(`${field}: ${where} listings have no such field`); continue }
    const stop = blocked(columns)
    if (stop) { refusals.push(`${field}: ${stop.writeBlockedReason ?? 'it cannot be edited here'}`); continue }
    const head = cellOf(columns[0])
    const address = head?.contentAcknowledgement?.pin.address ?? (head?.contentAddress?.tier === 'pin' ? head.contentAddress : null)
    if (!address) { refusals.push(`${field}: ${where} cannot keep its own ${language} text`); continue }
    pinAddress = address
    const own = ownPin(product, listing, coordinate, languages, field, language)
    const isFollow = follow.includes(field)
    const to = isFollow ? null : pin[field]
    if (isFollow ? own === null : own !== null && same(own.value, to)) { unchanged.push(field); continue }
    fields.push({ field, kind: isFollow ? 'follow' : 'pin', writerField: writerField(field), column: columns[0], to, from: shownValue(columns), own })
  }
  for (const code of codes) {
    const column = sheet.columns.find((col) => !isLocalizableContent(col.slot?.of ?? col.key, col.storage)
      && [col.key, col.writeField, `attr_${col.key}`].includes(code) && !col.slot)
    if (!column) {
      // A product attribute kept once for every channel is not one listing's to change.
      const sharedHere = has(product.categoryAttributes, code) || has(product.parent?.categoryAttributes, code)
        || (await prisma.customAttribute.count({ where: { code, archivedAt: null } })) > 0
      refusals.push(sharedHere
        ? `${code}: a shared attribute of the product, kept once for every channel — change it with bulk-attribute-change`
        : `${code}: ${where} listings have no such attribute`)
      continue
    }
    if (NOT_CONTENT_GROUPS.has(column.groupKey?.split(':').pop() ?? '')) { refusals.push(`${code}: a listing setting (offer, photos, shipping, policies), not text or an attribute`); continue }
    const cell = cellOf(column)
    if (!cell) { refusals.push(`${code}: not shown on this listing`); continue }
    if (!cell.editable) { refusals.push(`${code}: ${cell.writeBlockedReason ?? 'it cannot be edited here'}`); continue }
    if (cell.writeTarget !== 'channelListing') {
      refusals.push(`${code}: a shared attribute — changing it here would change it for every channel; change it with bulk-attribute-change`)
      continue
    }
    const store = storeOf(column, sheet.scope.label, row.productType)
    const stored = storedChannelState(listing as never, store, [column.key, column.writeField])
    const own: Own = stored.state === 'stored' ? { value: stored.value } : null
    const drop = drops.includes(code)
    const to = drop ? undefined : attributes[code]
    if (drop ? own === null : own !== null && same(own.value, to)) { unchanged.push(code); continue }
    fields.push({ field: column.key, kind: 'attribute', writerField: cell.writeField, column, to: drop ? null : to, drop, from: cell.value ?? null, own, ...(store ? { store } : {}) })
  }
  if (refusals.length) return { error: `Not possible on ${where} · ${named.sku}: ${listed(refusals)}. ${nothing}` }
  if (!fields.length) return { error: `Nothing to change: ${listed(unchanged)} already ${unchanged.length === 1 ? 'is' : 'are'} that way on ${where}. ${nothing}` }

  const meaning = (args.englishMeaning && typeof args.englishMeaning === 'object' ? args.englishMeaning : {}) as Record<string, string>
  const setKeys = new Set([...pins, ...codes, ...fields.map((f) => f.field)])
  const stray = Object.keys(meaning).filter((key) => !setKeys.has(key))
  if (stray.length) return { error: `englishMeaning names ${listed(stray)}, which this change does not set. ${nothing}` }
  if (language !== 'en') {
    const meaningOf = (f: ListingFieldPlan) => meaning[f.field] ?? (f.kind === 'attribute' ? meaning[codes.find((code) => code === f.field || code === f.writerField || code === `attr_${f.field}`) ?? ''] : undefined)
    const without = fields.filter((f) => f.kind !== 'follow' && !f.drop && hasText(f.to) && !meaningOf(f)?.trim()).map((f) => f.field)
    if (without.length) return { error: `englishMeaning is required for ${listed(without)}: what the new ${language} text says in English, for the person who approves it. ${nothing}` }
    for (const f of fields) { const m = meaningOf(f); if (m) f.englishMeaning = m }
  } else {
    for (const f of fields) if (meaning[f.field]) f.englishMeaning = meaning[f.field]
  }
  const pinVersion = listing.translations.find((t) => t.language === language)?.version ?? 0
  const label = `${where} · ${named.sku}${aliasKey ? ` (${aliasKey})` : ''}`
  return { product: { id: named.id, sku: named.sku, brand: product.brand ?? product.parent?.brand ?? null }, listing, label, language, coordinate, pinAddress, pinVersion, fields, unchanged }
}

function listingWrites(plan: ListingPlan): ProductBulkInput {
  const changes: Change[] = plan.fields.map((f) => f.kind === 'attribute'
    ? { id: plan.product.id, field: f.writerField, value: f.to, target: 'channel' as const, ...(f.drop ? { intent: 'reset' as const } : {}) }
    : {
        id: plan.product.id, field: f.writerField, value: f.kind === 'follow' ? null : f.to, contentAddress: plan.pinAddress!,
        contentAcknowledged: true, contentState: 'reviewed' as const, contentVersion: plan.pinVersion,
        ...(f.kind === 'follow' ? { intent: 'reset' as const } : {}),
      })
  return {
    changes,
    marketplaceContexts: [{
      channel: plan.coordinate.channel as never, marketplace: plan.coordinate.market, locale: plan.language, aliasKey: plan.coordinate.aliasKey,
      ...(plan.coordinate.accountId ? { accountId: plan.coordinate.accountId } : {}),
    }],
  }
}

/** What the listing keeps as its own now, for the plan's fields: the change record and its undo read the same. */
async function listingOwn(plan: Pick<ListingPlan, 'product' | 'coordinate' | 'language'>, fields: Array<{ field: string; kind: ListingKind; writerField: string; store?: ChannelStoreRef }>) {
  const product = await contentProduct(plan.product.id)
  const listing = product ? await findListing(plan.product.id, plan.coordinate.channel, plan.coordinate.market, plan.coordinate.accountId ?? undefined, plan.coordinate.aliasKey) : null
  if (!product || !listing || listing === 'many') return null
  const languages = await marketLanguages(plan.coordinate.channel, plan.coordinate.market)
  const pins: Record<string, Own> = {}
  const attributes: Record<string, Own> = {}
  for (const f of fields) {
    if (f.kind !== 'attribute') pins[f.field] = ownPin(product, listing, plan.coordinate, languages, f.field, plan.language)
    else {
      // The attribute's own stored value: the channel's store for it, by the keys the writer stores it under.
      const stored = storedChannelState(listing as never, f.store, [f.field, f.writerField])
      attributes[f.writerField] = stored.state === 'stored' ? { value: stored.value } : null
    }
  }
  return { pins, attributes }
}

/** C2 — undo of set-listing-content: a new set-listing-content that puts back what the listing kept as its own. */
export const SET_LISTING_CONTENT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; sku?: string; coordinate?: ListingPlan['coordinate']; language?: string; pins?: Record<string, Own>; attributes?: Record<string, Own>; stores?: Record<string, { field: string; store?: ChannelStoreRef }> }
    if (!after.productId || !after.coordinate || !after.language) return { missing: true }
    const fields = [
      ...Object.keys(after.pins ?? {}).map((field) => ({ field, kind: 'pin' as const, writerField: writerField(field) })),
      ...Object.keys(after.attributes ?? {}).map((writer) => ({ field: after.stores?.[writer]?.field ?? writer.replace(/^attr_/, ''), kind: 'attribute' as const, writerField: writer, store: after.stores?.[writer]?.store })),
    ]
    const now = await listingOwn({ product: { id: after.productId, sku: after.sku ?? '', brand: null }, coordinate: after.coordinate, language: after.language }, fields)
    return { ...after, pins: now?.pins ?? 'listing not found', attributes: now?.attributes ?? 'listing not found' }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: unknown; coordinate?: ListingPlan['coordinate']; language?: unknown; pins?: Record<string, Own>; attributes?: Record<string, Own> }
    if (typeof before.productId !== 'string' || !before.coordinate || typeof before.language !== 'string') return { refusal: 'This change does not name its listing and language.' }
    const coordinate = { channel: before.coordinate.channel, market: before.coordinate.market,
      ...(before.coordinate.accountId ? { accountId: before.coordinate.accountId } : {}), ...(before.coordinate.aliasKey ? { aliasKey: before.coordinate.aliasKey } : {}) }
    const pin: Record<string, unknown> = {}
    const follow: string[] = []
    const attributes: Record<string, unknown> = {}
    const dropAttributes: string[] = []
    const englishMeaning: Record<string, string> = {}
    // Exactly what the listing kept: its own text (or its own empty text), each attribute with its JSON type.
    for (const [field, own] of Object.entries(before.pins ?? {})) {
      if (own === null) { follow.push(field); continue }
      pin[field] = LIST_FIELDS.has(field) ? (Array.isArray(own.value) ? own.value.map(String) : []) : own.value == null ? null : String(own.value)
      if (hasText(pin[field])) englishMeaning[field] = UNDO_MEANING
    }
    for (const [writer, own] of Object.entries(before.attributes ?? {})) {
      if (own === null) { dropAttributes.push(writer); continue }
      attributes[writer] = own.value ?? null
      if (hasText(attributes[writer])) englishMeaning[writer] = UNDO_MEANING
    }
    const args: Record<string, unknown> = { product: before.productId, coordinate, language: before.language }
    if (Object.keys(pin).length) args.pin = pin
    if (follow.length) args.follow = follow
    if (Object.keys(attributes).length) args.attributes = attributes
    if (dropAttributes.length) args.dropAttributes = dropAttributes
    if (Object.keys(englishMeaning).length) args.englishMeaning = englishMeaning
    return args.pin || args.follow || args.attributes || args.dropAttributes ? { tool: 'set-listing-content', args } : { refusal: 'This change named no field.' }
  },
}

function listingChanges(plan: ListingPlan, shared: Record<string, unknown>) {
  return Object.fromEntries(plan.fields.map((f) => [f.kind === 'attribute' ? f.writerField.replace(/^attr_/, '') : f.field, {
    kind: f.kind,
    from: f.from,
    to: f.kind === 'follow' ? shared[f.field] ?? null : f.to,
    ...(f.englishMeaning ? { englishMeaning: f.englishMeaning } : {}),
  }]))
}

/** What a field shows once the listing follows the shared text again: the resolver without the listing. */
function sharedTextOf(product: ContentRow, fields: string[], language: string): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, resolveContent({
    product: product as unknown as ContentProduct, parent: (product.parent ?? null) as unknown as ContentProduct | null, field, address: { requested: language },
  }).value]))
}

const setListingContent: AgentTool = {
  name: 'set-listing-content',
  title: "Set one listing's own text",
  input: setListingContentInput,
  requires: [F.productsEdit, F.listingsEdit],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_LISTING_CONTENT_UNDO,
  description:
    'Change what one listing (Amazon, eBay or Etsy + market; Etsy: GLOBAL) shows, without touching the shared text or any other listing: '
    + 'pin = text this listing keeps as its own; follow = fields it stops keeping, so they show the shared text again; '
    + 'attributes = its own channel attributes (Amazon attributes, eBay item specifics, Etsy attributes such as material), each with its type; '
    + 'dropAttributes = attributes it stops keeping its own value for. The '
    + 'language must be one of the market\'s. Refused when the product has no listing there yet (create it first), or '
    + 'when a field cannot be edited (the reason is given). Give englishMeaning for every text set unless the language '
    + 'is en. A person approves it in Nexus, and the approval is its review. Saved in Nexus only: the channel changes '
    + 'when the listing is published from Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planListingContent(args, NOTHING)
    if ('error' in plan) return { ok: false, error: plan.error }
    const checked = await runContentWriter({ ...listingWrites(plan), dryRun: true }, contentWriterContext(null, 'set-listing-content'), (row) => row.field.replace(/^attr_/, ''))
    if ('refusal' in checked) return { ok: false, error: `${checked.refusal.replace(/[.\s]+$/, '')}. ${NOTHING}` }
    const product = await contentProduct(plan.product.id)
    const shared = product ? sharedTextOf(product, plan.fields.filter((f) => f.kind === 'follow').map((f) => f.field), plan.language) : {}
    const hits = await glossaryFindings(plan.product.brand, plan.language, plan.fields.filter((f) => f.kind !== 'follow').map((f) => ({ field: f.field, value: f.to })))
    return {
      ok: true,
      preview: {
        action: 'set-listing-content',
        productId: plan.product.id,
        sku: plan.product.sku,
        listing: plan.label,
        language: plan.language,
        changes: listingChanges(plan, shared),
        reach: { listing: plan.label, status: plan.listing.listingStatus, otherListingsChange: false },
        basis: basisOf({ listing: plan.listing.id, language: plan.language, pinVersion: plan.pinVersion, own: plan.fields.map((f) => [f.kind, f.writerField, f.own]) }),
        ...(plan.unchanged.length ? { unchanged: plan.unchanged } : {}),
        ...(checked.warnings.length ? { warnings: checked.warnings } : {}),
        ...(hits.length ? { glossaryHits: hits } : {}),
        note: `${NEXUS_ONLY} Only this listing changes: the shared text and the other listings stay as they are. Saved as reviewed text: approving it is its review.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planListingContent(args, NOTHING_WRITTEN)
    if ('error' in plan) return { ok: false, error: plan.error }
    const written = await runContentWriter(
      { ...listingWrites(plan), expectedVersion: plan.listing.version },
      contentWriterContext(ctx.userId, 'set-listing-content'),
      (row) => row.field.replace(/^attr_/, ''),
    )
    if ('refusal' in written) return { ok: false, error: `${written.refusal.replace(/[.\s]+$/, '')}. ${NOTHING_WRITTEN}` }
    // Where each attribute is stored, kept on both sides so the undo reads it back the same way.
    const stores = Object.fromEntries(plan.fields.filter((f) => f.kind === 'attribute').map((f) => [f.writerField, { field: f.field, ...(f.store ? { store: f.store } : {}) }]))
    const record = (own: { pins: Record<string, Own>; attributes: Record<string, Own> }) => ({
      productId: plan.product.id, sku: plan.product.sku, listingId: plan.listing.id, coordinate: plan.coordinate, language: plan.language, ...own,
      ...(Object.keys(stores).length ? { stores } : {}),
    })
    const before = {
      pins: Object.fromEntries(plan.fields.filter((f) => f.kind !== 'attribute').map((f) => [f.field, f.own])),
      attributes: Object.fromEntries(plan.fields.filter((f) => f.kind === 'attribute').map((f) => [f.writerField, f.own])),
    }
    const after = await listingOwn(plan, plan.fields)
    return {
      ok: true,
      data: { productId: plan.product.id, listing: plan.label, language: plan.language, applied: plan.fields.map((f) => `${f.kind} ${f.field}`), ...(written.warnings.length ? { warnings: written.warnings } : {}) },
      change: { before: record(before), after: record(after ?? { pins: {}, attributes: {} }) },
    }
  },
}


// ── bulk-content-change ────────────────────────────────────────────────────────────────────────────────

/** Products one bulk content change may name (one approval reads them all), and the most its arguments may weigh. */
export const BULK_CONTENT_MAX_PRODUCTS = 25
export const BULK_CONTENT_MAX_BYTES = 512 * 1024
/** Changes the preview shows; the rest are counted (`moreChanges`) and still fingerprinted (`basis`). */
const BULK_PREVIEW_CHANGES = 20

const contentItem = z.object({
  product: z.string().trim().min(1).max(191).describe('the product: a Nexus product id or a SKU'),
  title: z.string().max(1000).nullable().optional().describe('new title'),
  bulletPoints: z.array(z.string().max(2000)).max(MAX_BULLETS).optional().describe(`new bullet points, at most ${MAX_BULLETS}`),
  description: z.string().max(20_000).nullable().optional().describe('new description, or null for none'),
  keywords: z.array(z.string().max(500)).max(MAX_KEYWORDS).optional().describe(`new search keywords, at most ${MAX_KEYWORDS}`),
  attributes: z.record(z.string().regex(ATTRIBUTE_CODE), z.string().max(5000).nullable()).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES, { message: `at most ${MAX_ATTRIBUTES} attributes` })
    .describe(`translatable text attributes, by code, at most ${MAX_ATTRIBUTES}`),
  reset: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_ATTRIBUTES + TEXT_FIELDS.length).optional()
    .describe('fields to drop from this language so they show the source text again (not for the primary language)'),
  englishMeaning: z.record(z.string().trim().min(1).max(100), z.string().max(20_000)).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_ATTRIBUTES + TEXT_FIELDS.length, { message: 'too many fields' })
    .describe('per field set, what the new text says in English: required for every field set unless the language is en'),
})

const bulkContentInput = z.object({
  language: languageArg.describe('the one language of every text: the primary language (it) changes the source text, any other the shared text in that language'),
  items: z.array(contentItem).min(1).max(BULK_CONTENT_MAX_PRODUCTS)
    .describe(`one entry per product, 1 to ${BULK_CONTENT_MAX_PRODUCTS}: its new texts and their English meaning`),
})

interface BulkPlan {
  language: string
  tier: 'source' | 'language'
  plans: SharedPlan[]
}

/** Every item's plan from what is stored NOW. One item that cannot change refuses them all. */
async function planBulkContent(args: Record<string, unknown>): Promise<BulkPlan | Refusal> {
  const bytes = Buffer.byteLength(JSON.stringify(args))
  if (bytes > BULK_CONTENT_MAX_BYTES) {
    return { error: `This change is ${Math.ceil(bytes / 1024)} KB; one change may carry at most ${BULK_CONTENT_MAX_BYTES / 1024} KB of text. Split it into smaller changes.` }
  }
  const language = String(args.language ?? '')
  const items = (Array.isArray(args.items) ? args.items : []) as Array<Record<string, unknown>>
  const plans: SharedPlan[] = []
  const refusals: string[] = []
  for (const item of items) {
    const plan = await planSharedContent(sharedRequest({ ...item, language }), '')
    if ('error' in plan) refusals.push(`${String(item.product)}: ${plan.error.trim().replace(/[.\s]+$/, '')}`)
    else plans.push(plan)
  }
  if (refusals.length) return { error: `${refusals.length} of ${items.length} ${items.length === 1 ? 'product' : 'products'} cannot change, so none does: ${listed(refusals, 5)}` }
  const twice = plans.filter((plan, i) => plans.findIndex((other) => other.product.id === plan.product.id) !== i).map((plan) => plan.product.sku)
  if (twice.length) return { error: `${listed([...new Set(twice)])} ${twice.length === 1 ? 'is' : 'are'} named more than once: name each product once.` }
  return { language: plans[0].language, tier: plans[0].tier, plans }
}

/** Per product and field, what the person reads; all of them, in item order. */
function bulkChanges(plan: BulkPlan) {
  return plan.plans.flatMap((p) => Object.entries(sharedChanges(p)).map(([field, change]) => ({ sku: p.product.sku, field, ...change })))
}

const bulkContentChange: AgentTool = {
  name: 'bulk-content-change',
  title: 'Change text on many products',
  input: bulkContentInput,
  requires: [F.productsEdit, F.productsTranslationsEdit, F.productsBulkRun],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  description:
    `Change the shared text of 1 to ${BULK_CONTENT_MAX_PRODUCTS} products in one language, in one approval: per product `
    + 'the title, bullet points, description, keywords or translatable attributes, or reset (drop a language\'s own text). '
    + `Give englishMeaning for every field set unless the language is en. At most ${BULK_CONTENT_MAX_BYTES / 1024} KB of `
    + 'arguments. If any one product cannot change, none does, and the answer says why. The preview shows the first '
    + `${BULK_PREVIEW_CHANGES} changes, the totals, how many listings show the new texts, the glossary's avoid words and `
    + 'the writer\'s warnings. A person approves it in Nexus, and the approval is the texts\' review. Saved in Nexus only: '
    + 'the channels change when the listings are published from Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planBulkContent(args)
    if ('error' in plan) return { ok: false, error: `${plan.error}. ${NOTHING}` }
    const skuOf = new Map(plan.plans.map((p) => [p.product.id, p.product.sku]))
    const checked = await runContentWriter(
      { changes: plan.plans.flatMap(sharedWrites), dryRun: true }, contentWriterContext(null, 'bulk-content-change'),
      (row) => `${skuOf.get(row.id) ?? row.id} ${row.field.replace(/^attr_/, '')}`,
    )
    if ('refusal' in checked) return { ok: false, error: `${checked.refusal.replace(/[.\s]+$/, '')}. ${NOTHING}` }
    const reaches = await Promise.all(plan.plans.map((p) => reachOf(p.product, p.fields.map((f) => f.field), p.language)))
    const following = new Set<string>()
    const ownText = new Set<string>()
    for (const reach of reaches) for (const r of Object.values(reach)) { r.follow.forEach((l) => following.add(l)); r.ownPin.forEach((l) => ownText.add(l)) }
    const hits = (await Promise.all(plan.plans.map((p) => glossaryHitsFor(p, p.product.sku)))).flat()
    const changes = bulkChanges(plan)
    return {
      ok: true,
      preview: {
        action: 'bulk-content-change',
        language: plan.language,
        layer: plan.tier,
        totals: { products: plan.plans.length, changes: changes.length },
        changes: changes.slice(0, BULK_PREVIEW_CHANGES),
        ...(changes.length > BULK_PREVIEW_CHANGES ? { moreChanges: changes.length - BULK_PREVIEW_CHANGES } : {}),
        reach: { listingsFollowing: following.size, listingsWithOwnText: ownText.size },
        // Everything it was worked out from, beyond the lines shown: every product's stored text, its row version,
        // every change (also those past the first 20) and every listing it reaches.
        basis: basisOf({ plans: plan.plans.map((p) => [p.product.id, sharedBasis(p)]), changes, reaches }),
        ...(checked.warnings.length ? { warnings: checked.warnings.slice(0, BULK_PREVIEW_CHANGES), ...(checked.warnings.length > BULK_PREVIEW_CHANGES ? { moreWarnings: checked.warnings.length - BULK_PREVIEW_CHANGES } : {}) } : {}),
        ...(hits.length ? { glossaryHits: hits.slice(0, BULK_PREVIEW_CHANGES) } : {}),
        note: `${NEXUS_ONLY} Saved as reviewed text: approving it is the texts' review. The English meanings are Claude's own reading of the new texts.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      // One transaction: one product refused rolls every product back.
      return await inDatabaseTransaction(prisma, async () => {
        const plan = await planBulkContent(args)
        if ('error' in plan) throw new ContentRefused(plan.error)
        for (const p of plan.plans) {
          const written = await runContentWriter({ changes: sharedWrites(p), expectedVersion: p.product.version },
            contentWriterContext(ctx.userId, 'bulk-content-change'), (row) => `${p.product.sku} ${row.field.replace(/^attr_/, '')}`)
          if ('refusal' in written) throw new ContentRefused(`${p.product.sku}: ${written.refusal}`)
          await dropEmptyLanguageRow(p, ctx.userId, 'bulk-content-change')
        }
        const products: Record<string, { sku: string; before: Record<string, Own>; after: Record<string, Own> }> = {}
        for (const p of plan.plans) {
          const fields = p.fields.map((f) => f.field)
          const now = await contentProduct(p.product.id)
          products[p.product.id] = { sku: p.product.sku, before: Object.fromEntries(p.fields.map((f) => [f.field, f.own])), after: now ? ownFields(now, fields, p.tier, p.language) : {} }
        }
        const record = (side: 'before' | 'after') => ({
          language: plan.language, tier: plan.tier,
          products: Object.fromEntries(Object.entries(products).map(([id, p]) => [id, { sku: p.sku, fields: p[side] }])),
        })
        return {
          ok: true,
          data: { language: plan.language, products: plan.plans.map((p) => p.product.sku), changes: plan.plans.reduce((n, p) => n + p.fields.length, 0) },
          change: { before: record('before'), after: record('after') },
        }
      })
    } catch (error) {
      if (error instanceof ContentRefused) return { ok: false, error: `${error.message.replace(/[.\s]+$/, '')}. ${NOTHING_WRITTEN}` }
      throw error
    }
  },
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { language?: string; tier?: 'source' | 'language'; products?: Record<string, { sku?: string; fields?: Record<string, Own> }> }
      const products: Record<string, unknown> = {}
      for (const [id, p] of Object.entries(after.products ?? {})) {
        const now = await contentProduct(id)
        const fields = Object.keys(p.fields ?? {})
        products[id] = { sku: p.sku, fields: now ? ownFields(now, fields, after.tier ?? 'source', after.language ?? '') : 'product not found' }
      }
      return { language: after.language, tier: after.tier, products }
    },
    request(change) {
      const before = (change.before ?? {}) as { language?: unknown; products?: Record<string, { fields?: Record<string, Own> }> }
      if (typeof before.language !== 'string' || !before.products) return { refusal: 'This change does not name its language and products.' }
      const items = Object.entries(before.products).map(([id, p]) => ({ product: id, ...undoFieldArgs(p.fields ?? {}) })).filter((item) => Object.keys(item).length > 1)
      return items.length ? { tool: 'bulk-content-change', args: { language: before.language, items } } : { refusal: 'This change named no field.' }
    },
  },
}

export const CONTENT_CHANGE_TOOLS: AgentTool[] = [setContent, setListingContent, bulkContentChange]

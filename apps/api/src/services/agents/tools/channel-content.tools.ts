/**
 * MCP full control T11 (docs/mcp-full-control/sections/03-content.md §3, §6 step 11, phase 2) — content that lives on a
 * channel, read from the channel itself.
 *
 *   shopify-content       one product's Shopify listing as the product sheet's Shopify scope shows it: the store's own
 *                         fields (metafields, vendor, tags, product type, category, SEO) read live from the store, and
 *                         the Nexus draft values waiting to be synchronized
 *   set-shopify-content   change those store fields in the listing's Nexus draft (the linked workspace), through the
 *                         Shopify sheet's own writer (`saveShopifySheetCells`); Shopify changes when the draft is
 *                         synchronized from Nexus. Approved by a person.
 *   listing-live-content  what one listing holds on its channel right now (`readLiveListing` / `publicLiveRead`: one
 *                         read per listing per 30 s, through the channel clients; the raw provider documents stay on the
 *                         server)
 *
 * These read a marketplace (openWorld). Channel logins are sealed with the production key, so a live read works only in
 * the deployed API; locally it answers with the read's own error.
 *
 * 🔴 The Shopify sheet drops EVERY store metafield when it has no copy of the store's field list (`meta.schemaMissing`
 * holds `SHOPIFY:…`, reference_shopify_sheet_drops_metafields_on_cold_schema): the read then says the store fields are
 * missing, never empty, and a write is refused.
 *
 * Etsy: no tool here reads or writes Etsy text until the Etsy publish step (P5) exists (ETSY_NOT_YET).
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { channelLabel } from '@nexus/shared/channel-label'
import { formerNamesOf } from '@nexus/shared/sheet-names'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import type { InformationField } from '@nexus/shared/shopify-information'
import prisma from '../../../db.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import {
  cellOf, COORDINATE_CHANNELS, ETSY_NOT_YET, factsOf, languageArg, languageOf, liveProductByRef, sheetRefusal,
  type Field, type RequiredCheck,
} from './content.tools.js'
import type { StudioRow, StudioSheet } from '../../pim/studio-sheet.service.js'
import type { SheetColumn } from '../../pim/sheet-columns.service.js'

const MAX_FIELDS = 50
const MAX_VARIATIONS = 20
const NOTHING = 'Nothing was queued.'
const NOTHING_WRITTEN = 'Nothing was changed.'
const UNDO_MEANING = 'Undo: puts back the value this field had before the change. No English meaning was recorded for it.'
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const listed = (items: string[], cap = 10) => (items.length > cap ? `${items.slice(0, cap).join(', ')} and ${items.length - cap} more` : items.join(', '))
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const text = (value: unknown): string | null => (value == null ? null : typeof value === 'string' ? value : JSON.stringify(value))
const hasText = (value: unknown) => typeof value === 'string' && value.trim() !== '' && !/^[-+]?\d+(\.\d+)?$/.test(value.trim()) && !['true', 'false'].includes(value.trim())

// ── Shopify: which of the store's fields are text and attributes ───────────────────────────────────────

/** Shopify's own product fields that are text or attributes. Price, cost, stock, status, sales channels, media and the
 *  variant's identity are the listings and stock parts' (and some are money). */
const SHOPIFY_TEXT_FIELDS = new Set(['title', 'descriptionHtml', 'tags', 'productType', 'vendor', 'seo.title', 'seo.description', 'category'])
const isShopifyContent = (field: InformationField) =>
  !/money/i.test(field.type) && !field.currency && (SHOPIFY_TEXT_FIELDS.has(field.id) || field.discovery === 'definition')

const SHOPIFY_FIELDS_MISSING =
  'Nexus has no copy of this store\'s field list yet, so the Shopify sheet has dropped every store metafield from this read: they are missing here, not empty.'

const shopifySchemaMissing = (sheet: StudioSheet) => sheet.meta.schemaMissing.some((key) => key === 'SHOPIFY' || key.startsWith('SHOPIFY:'))

function shopifyFields(sheet: StudioSheet): Array<Field & { info: InformationField }> {
  return sheet.columns.filter((column) => column.shopifyField && isShopifyContent(column.shopifyField))
    .map((column) => ({ name: column.shopifyField!.id, content: false, columns: [column], info: column.shopifyField! }))
}

const fieldMatch = (field: Field & { info: InformationField }, raw: string) => {
  const key = raw.trim().toLowerCase()
  return [field.name, field.columns[0].key, field.columns[0].label, field.info.label, field.info.channelLabel].some((name) => name?.toLowerCase() === key)
}
/** W3-6 — a field by a name its column had before ("Brand" → Vendor, "Name" → Title); asked only after every current name. */
const formerMatch = (field: Field & { info: InformationField }, raw: string) =>
  formerNamesOf(field.columns[0].key).some((name) => name.toLowerCase() === raw.trim().toLowerCase())

/** The product sheet's Shopify scope for a product, read live from the store (the sheet's own enrichment). */
async function readShopifySheet(productId: string, accountId: string | undefined, language: string | undefined): Promise<StudioSheet | { error: string }> {
  try {
    const { getInformationSheet } = await import('../../pim/information-sheet.js')
    return await getInformationSheet({ productId, scope: 'channel', channel: 'SHOPIFY', market: 'GLOBAL',
      ...(accountId ? { accountId } : {}), ...(language ? { locale: language } : {}) })
  } catch (error) {
    const refusal = sheetRefusal(error)
    if (refusal) return { error: refusal }
    throw error
  }
}

/**
 * The Shopify store account of the family's listing (one, or the one asked for), read from Nexus before anything reads
 * the store: a product with no Shopify listing is answered in words, without a live read.
 */
async function shopifyAccount(named: { id: string; sku: string; parentId: string | null }, accountId: string | undefined, aliasKey: string | null): Promise<{ accountId: string } | { error: string }> {
  const family = named.parentId ?? named.id
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'SHOPIFY', aliasKey: aliasKey ?? '', product: { deletedAt: null, OR: [{ id: family }, { parentId: family }] }, ...(accountId ? { channelConnectionId: accountId } : {}) },
    select: { channelConnectionId: true },
  })
  const accounts = [...new Set(listings.map((l) => l.channelConnectionId).filter((id): id is string => !!id))]
  if (!accounts.length) return { error: `${named.sku} has no Shopify listing${aliasKey ? ` "${aliasKey}"` : ''} yet: create the listing first.` }
  if (accounts.length > 1) return { error: `${named.sku} is listed in ${accounts.length} Shopify stores: name the store account (accountId).` }
  return { accountId: accounts[0] }
}

const requiredCheck = async (): Promise<RequiredCheck> => {
  const { completenessFor } = await import('../../pim/sheet-rows.service.js')
  return (column, row) => completenessFor([column], {
    isParent: row.productRole ? row.productRole === 'parent' : row.isParent, productType: row.productType, familyId: row.familyId ?? null,
  }, row.values as never).required.total > 0
}

const accountArgs = {
  accountId: z.string().trim().min(1).max(64).optional().describe('the Shopify store account, when the business has more than one'),
  aliasKey: z.string().trim().min(1).max(64).optional().describe('a second listing of the product in the store (its alias key)'),
}

// ── shopify-content ────────────────────────────────────────────────────────────────────────────────────

const shopifyContentInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product: a Nexus product id or a SKU (a variation names its family)'),
  ...accountArgs,
  language: languageArg.optional().describe("the store language to read, e.g. en or it (default: the store's own)"),
  fields: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_FIELDS).optional()
    .describe('only these fields: their ids or labels, e.g. vendor, tags, or a metafield (default: every text and attribute field)'),
})

const shopifyContent: AgentTool = {
  name: 'shopify-content',
  title: 'Shopify listing content',
  input: shopifyContentInput,
  requires: [F.productsView, F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    "Read one product's Shopify listing as the product sheet's Shopify scope shows it, live from the store: per row (the "
    + 'product and its variants) the store\'s text and attribute fields — metafields, vendor, tags, product type, category, '
    + 'SEO title and description, title and description — with each value, whether it is a Nexus draft waiting to be '
    + 'synchronized (nexusDraft), whether it is required, and why it cannot be edited. Price, stock, status and sales '
    + 'channels are not read here. When Nexus has no copy of the store\'s field list, it says the metafields are missing, '
    + 'never empty. Etsy is not available yet.',
  async handler(args): Promise<ToolResult> {
    const a = args as z.infer<typeof shopifyContentInput>
    const named = await liveProductByRef(a.product)
    if (!named) return { ok: false, error: PRODUCT_NOT_FOUND }
    const asked = a.language ? languageOf(a.language) : null
    if (asked && 'error' in asked) return { ok: false, error: asked.error }
    const account = await shopifyAccount(named, a.accountId, a.aliasKey ?? null)
    if ('error' in account) return { ok: false, error: account.error }
    const sheet = await readShopifySheet(named.id, account.accountId, asked && 'language' in asked ? asked.language : undefined)
    if ('error' in sheet) return { ok: false, error: sheet.error }
    const alias = a.aliasKey ?? null
    const rows = sheet.rows.filter((row) => (row.aliasId ?? null) === alias)
    if (!rows.length) return { ok: false, error: `There is no Shopify listing "${alias}" of this product.` }
    const parent = rows.find((row) => row.id === sheet.family.id) ?? rows[0]
    const variations = rows.filter((row) => row !== parent)
    const all = shopifyFields(sheet)
    const unknownFields: string[] = []
    let fields = all
    if (a.fields) {
      fields = []
      for (const raw of a.fields) {
        const hit = all.find((field) => fieldMatch(field, raw)) ?? all.find((field) => formerMatch(field, raw))
        if (hit && !fields.includes(hit)) fields.push(hit)
        else if (!hit) unknownFields.push(raw)
      }
    }
    const required = await requiredCheck()
    const language = sheet.scope.locale
    const rowOut = (row: StudioRow) => ({
      id: row.id,
      sku: row.sku,
      role: row.productRole ?? (row.parentId ? 'child' : 'parent'),
      listing: row.listing ? { status: row.listing.listingStatus, published: !!row.listing.isPublished } : null,
      cells: Object.fromEntries(fields.flatMap((field) => {
        const cell = cellOf(field, row, language, true, required)
        if (!cell) return []
        const source = row.values[field.columns[0].key]
        delete cell.followsShared
        return [[field.name, { ...cell, ...(source?.nexusDraft ? { nexusDraft: true } : {}) }]]
      })),
    })
    const missing = shopifySchemaMissing(sheet)
    return {
      ok: true,
      data: {
        product: { id: sheet.family.id, sku: sheet.family.sku, name: sheet.family.name },
        ...(named.id !== sheet.family.id ? { asked: { id: named.id, sku: named.sku } } : {}),
        store: sheet.scope.label,
        accountId: sheet.scope.connectionId,
        language,
        storeFieldsLoaded: !missing,
        ...(missing ? { storeFieldsNote: `${SHOPIFY_FIELDS_MISSING} Ask again in a minute: the list is read again from Shopify in the background.` } : {}),
        fields: fields.map(factsOf).map((facts, i) => ({ ...facts, label: fields[i].info.label })),
        rows: [rowOut(parent), ...variations.slice(0, MAX_VARIATIONS).map(rowOut)],
        ...(variations.length > MAX_VARIATIONS ? { moreVariations: variations.length - MAX_VARIATIONS } : {}),
        ...(unknownFields.length ? { unknownFields } : {}),
        note: 'Read live from Shopify, as the product sheet shows it. A nexusDraft value waits in Nexus until the listing is synchronized to Shopify.',
      },
    }
  },
}

// ── set-shopify-content ────────────────────────────────────────────────────────────────────────────────

const setShopifyContentInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product whose Shopify row it is: a Nexus product id or a SKU (a variant for variant fields)'),
  ...accountArgs,
  language: languageArg.optional().describe("the store language of the values, e.g. en or it (default: the store's own)"),
  fields: z.record(z.string().trim().min(1).max(200), z.string().max(20_000).nullable()).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_FIELDS, { message: `at most ${MAX_FIELDS} fields` })
    .describe('store fields to set, by id or label: { field: value } as the Shopify sheet takes it (a list or a reference as JSON text); null for empty'),
  reset: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_FIELDS).optional()
    .describe('store fields whose Nexus draft value is dropped: they take the value the product sheet maps or Shopify holds again'),
  englishMeaning: z.record(z.string().trim().min(1).max(200), z.string().max(20_000)).optional()
    .refine((value) => !value || Object.keys(value).length <= MAX_FIELDS, { message: 'too many fields' })
    .describe('per text field set, what the new text says in English, for the person who approves it: required unless the language is en'),
})

interface ShopifyFieldPlan {
  name: string
  column: SheetColumn
  ownerId: string
  fieldId: string
  token: string
  baseline: string | null
  reset: boolean
  from: unknown
  to: string | null
  nexusDraft: boolean
  englishMeaning?: string
}
interface ShopifyPlan {
  product: { id: string; sku: string }
  accountId: string
  aliasKey: string | null
  language: string
  label: string
  status: string | null
  fields: ShopifyFieldPlan[]
  unchanged: string[]
}

/** What each named field holds now on the product's Shopify row: its value and whether it is a Nexus draft. */
function fieldState(sheet: StudioSheet, row: StudioRow, names: string[]) {
  const all = shopifyFields(sheet)
  return Object.fromEntries(names.map((name) => {
    const field = all.find((f) => f.name === name)
    const cell = field ? row.values[field.columns[0].key] : undefined
    return [name, cell ? { value: cell.value ?? null, nexusDraft: !!cell.nexusDraft } : null]
  }))
}

async function planShopifyContent(args: Record<string, unknown>, nothing: string): Promise<ShopifyPlan | { error: string }> {
  const named = await liveProductByRef(String(args.product ?? ''))
  if (!named) return { error: PRODUCT_NOT_FOUND }
  const asked = typeof args.language === 'string' ? languageOf(args.language) : null
  if (asked && 'error' in asked) return { error: `${asked.error} ${nothing}` }
  const sets = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, string | null>
  const resets = [...new Set(Array.isArray(args.reset) ? (args.reset as string[]) : [])]
  // In name order: a stored approval's arguments come back from jsonb with their keys re-ordered.
  const names = [...new Set([...Object.keys(sets), ...resets])].sort((x, y) => x.localeCompare(y))
  if (!names.length) return { error: `Name what to change: fields or reset. ${nothing}` }
  const both = resets.filter((name) => name in sets)
  if (both.length) return { error: `${listed(both)} cannot be set and reset in one change. ${nothing}` }

  const account = await shopifyAccount(named, typeof args.accountId === 'string' ? args.accountId : undefined, typeof args.aliasKey === 'string' ? args.aliasKey : null)
  if ('error' in account) return { error: `${account.error} ${nothing}` }
  const sheet = await readShopifySheet(named.id, account.accountId, asked && 'language' in asked ? asked.language : undefined)
  if ('error' in sheet) return { error: `${sheet.error} ${nothing}` }
  // 🔴 Without the store's field list the sheet has no metafields at all: a write now could not see what it changes.
  if (shopifySchemaMissing(sheet)) return { error: `${SHOPIFY_FIELDS_MISSING} A write is refused until it is loaded: ask again in a minute. ${nothing}` }
  const aliasKey = typeof args.aliasKey === 'string' ? args.aliasKey : null
  const row = sheet.rows.find((r) => r.id === named.id && (r.aliasId ?? null) === aliasKey)
  if (!row) return { error: `${named.sku} has no row in the Shopify listing${aliasKey ? ` "${aliasKey}"` : ''}. ${nothing}` }
  if (!row.listing) return { error: `${named.sku} has no Shopify listing yet: create the listing first. ${nothing}` }
  const all = shopifyFields(sheet)
  const fields: ShopifyFieldPlan[] = []
  const unchanged: string[] = []
  const refusals: string[] = []
  for (const name of names) {
    const field = all.find((f) => fieldMatch(f, name)) ?? all.find((f) => formerMatch(f, name))
    if (!field) {
      const other = sheet.columns.find((c) => c.shopifyField && [c.shopifyField.id, c.shopifyField.label, c.key, c.label, ...formerNamesOf(c.key)].some((n) => n.toLowerCase() === name.toLowerCase()))
      refusals.push(other ? `${name}: a listing setting (price, stock, status, sales channels, media), not text or an attribute` : `${name}: not a field of this store's Shopify listings`)
      continue
    }
    const cell = row.values[field.columns[0].key]
    if (!cell) { refusals.push(`${name}: not on this row (a variant field is set on the variant, a product field on the product)`); continue }
    if (!cell.editable) { refusals.push(`${name}: ${cell.writeBlockedReason ?? 'it cannot be edited here'}`); continue }
    const write = cell.shopifyWrite
    if (!write) {
      refusals.push(cell.contentAcknowledgement || cell.contentAddress
        ? `${name}: the listing's text follows the shared text — change it with set-content`
        : `${name}: the Shopify sheet does not write this field`)
      continue
    }
    const reset = resets.includes(name)
    const to = reset ? null : sets[name]
    if (!reset && field.info.definition && to !== null) {
      const problem = validateShopifyField(field.info.definition, to)
      if (problem) { refusals.push(`${name}: ${problem}`); continue }
    }
    if (reset ? !cell.nexusDraft : text(cell.value) === to) { unchanged.push(name); continue }
    fields.push({ name: field.name, column: field.columns[0], ownerId: write.ownerId, fieldId: write.fieldId, token: write.token, baseline: write.baseline,
      reset, from: cell.value ?? null, to, nexusDraft: !!cell.nexusDraft })
  }
  if (refusals.length) return { error: `Not possible on Shopify · ${named.sku}: ${listed(refusals)}. ${nothing}` }
  if (!fields.length) return { error: `Nothing to change: ${listed(unchanged)} already ${unchanged.length === 1 ? 'is' : 'are'} that way. ${nothing}` }
  const language = sheet.scope.locale
  const meaning = (args.englishMeaning && typeof args.englishMeaning === 'object' ? args.englishMeaning : {}) as Record<string, string>
  const meaningOf = (f: ShopifyFieldPlan) => meaning[f.name] ?? Object.entries(meaning).find(([key]) => fieldMatch(all.find((x) => x.name === f.name)!, key))?.[1]
    ?? Object.entries(meaning).find(([key]) => formerMatch(all.find((x) => x.name === f.name)!, key))?.[1]
  if (language !== 'en') {
    const without = fields.filter((f) => !f.reset && hasText(f.to) && !meaningOf(f)?.trim()).map((f) => f.name)
    if (without.length) return { error: `englishMeaning is required for ${listed(without)}: what the new ${language} text says in English, for the person who approves it. ${nothing}` }
  }
  for (const f of fields) { const m = meaningOf(f); if (m) f.englishMeaning = m }
  return {
    product: { id: named.id, sku: named.sku }, accountId: sheet.scope.connectionId ?? '', aliasKey, language,
    label: `${channelLabel('SHOPIFY')} · ${named.sku}${aliasKey ? ` (${aliasKey})` : ''}`, status: row.listing.listingStatus ?? null, fields, unchanged,
  }
}

/** The Shopify sheet's writer for these cells (its own token and baseline checks); the answer per field. */
async function saveCells(plan: ShopifyPlan, actor: string | null) {
  const { saveShopifySheetCells } = await import('../../shopify/channel-sheet.service.js')
  return saveShopifySheetCells(plan.product.id, { accountId: plan.accountId, market: 'GLOBAL', ...(plan.aliasKey ? { aliasKey: plan.aliasKey } : {}), locale: plan.language }, {
    cells: plan.fields.map((f) => ({ colId: f.column.key, receiptKey: f.name, ownerId: f.ownerId, fieldId: f.fieldId, token: f.token, baseline: f.baseline,
      value: f.reset ? null : f.to, intent: f.reset ? 'reset' as const : 'set' as const })),
  }, actor) as Promise<{ ok: boolean; cells: Record<string, { ok: boolean; reason?: string }> }>
}

type ShopifyChange = { productId: string; accountId: string; aliasKey: string | null; language: string; fields: Record<string, { value: unknown; nexusDraft: boolean } | null> }

/** C2 — undo: a new set-shopify-content that sets each field's earlier Nexus draft value again, or drops the draft. */
export const SET_SHOPIFY_CONTENT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Partial<ShopifyChange>
    if (!after.productId) return { missing: true }
    const sheet = await readShopifySheet(after.productId, after.accountId, after.language)
    if ('error' in sheet) return { ...after, fields: sheet.error }
    const row = sheet.rows.find((r) => r.id === after.productId && (r.aliasId ?? null) === (after.aliasKey ?? null))
    return { ...after, fields: row ? fieldState(sheet, row, Object.keys(after.fields ?? {})) : 'row not found' }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<ShopifyChange>
    if (typeof before.productId !== 'string') return { refusal: 'This change does not name its product.' }
    const fields: Record<string, string | null> = {}
    const reset: string[] = []
    const englishMeaning: Record<string, string> = {}
    for (const [name, state] of Object.entries(before.fields ?? {})) {
      if (!state || !state.nexusDraft) { reset.push(name); continue }
      fields[name] = text(state.value)
      if (hasText(fields[name])) englishMeaning[name] = UNDO_MEANING
    }
    const args: Record<string, unknown> = { product: before.productId, ...(before.accountId ? { accountId: before.accountId } : {}),
      ...(before.aliasKey ? { aliasKey: before.aliasKey } : {}), ...(before.language ? { language: before.language } : {}) }
    if (Object.keys(fields).length) args.fields = fields
    if (reset.length) args.reset = reset
    if (Object.keys(englishMeaning).length) args.englishMeaning = englishMeaning
    return args.fields || args.reset ? { tool: 'set-shopify-content', args } : { refusal: 'This change named no field.' }
  },
}

const setShopifyContent: AgentTool = {
  name: 'set-shopify-content',
  title: "Set a Shopify listing's store fields",
  input: setShopifyContentInput,
  requires: [F.productsEdit, F.listingsEdit],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  // It reads the store live (the sheet's own read, and the writer's checks); it writes only the Nexus draft.
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_SHOPIFY_CONTENT_UNDO,
  description:
    "Change a Shopify listing's store fields — metafields, vendor, tags, product type, category, SEO title and "
    + 'description — in the listing\'s Nexus draft, through the Shopify sheet\'s own writer; reset drops a field\'s draft '
    + 'value. Shopify changes only when a person reviews and sends the draft in the Nexus product studio (Review and '
    + 'synchronize): no Claude tool and no sync sends a draft with unreviewed changes. The listing\'s title and description follow the '
    + 'shared text (set-content). Refused when Nexus has no copy of the store\'s field list (the metafields would be '
    + 'invisible), when the product has no Shopify listing yet, and for a field that cannot be edited (the reason is '
    + 'given). Give englishMeaning for every text set unless the store language is en. A person approves it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planShopifyContent(args, NOTHING)
    if ('error' in plan) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: 'set-shopify-content',
        productId: plan.product.id,
        sku: plan.product.sku,
        listing: plan.label,
        language: plan.language,
        changes: Object.fromEntries(plan.fields.map((f) => [f.name, {
          from: f.from, to: f.to, ...(f.reset ? { reset: true } : {}), ...(f.englishMeaning ? { englishMeaning: f.englishMeaning } : {}),
        }])),
        reach: { listing: plan.label, status: plan.status, otherListingsChange: false },
        // The writer's own tokens and baselines: a draft edit or a Shopify change in between moves it.
        basis: basisOf(plan.fields.map((f) => [f.name, f.ownerId, f.token, f.baseline, f.nexusDraft])),
        ...(plan.unchanged.length ? { unchanged: plan.unchanged } : {}),
        note: 'Saved in the Shopify listing\'s Nexus draft only: Shopify changes when the draft is synchronized from Nexus, and its automation waits for a review.',
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planShopifyContent(args, NOTHING_WRITTEN)
    if ('error' in plan) return { ok: false, error: plan.error }
    const result = await saveCells(plan, ctx.userId ?? null)
    const saved = plan.fields.filter((f) => result.cells[f.name]?.ok)
    const refused = plan.fields.filter((f) => !result.cells[f.name]?.ok).map((f) => `${f.name}: ${result.cells[f.name]?.reason ?? 'not saved'}`)
    if (!saved.length) return { ok: false, error: `The Shopify sheet refused it: ${listed(refused)}. ${NOTHING_WRITTEN}` }
    const record = (fields: ShopifyChange['fields']): ShopifyChange => ({ productId: plan.product.id, accountId: plan.accountId, aliasKey: plan.aliasKey, language: plan.language, fields })
    const sheet = await readShopifySheet(plan.product.id, plan.accountId, plan.language)
    const row = 'error' in sheet ? undefined : sheet.rows.find((r) => r.id === plan.product.id && (r.aliasId ?? null) === plan.aliasKey)
    const names = saved.map((f) => f.name)
    return {
      ok: true,
      data: { productId: plan.product.id, listing: plan.label, saved: names, ...(refused.length ? { refused, refusedNote: 'Only the saved fields changed.' } : {}) },
      change: {
        before: record(Object.fromEntries(saved.map((f) => [f.name, { value: f.from, nexusDraft: f.nexusDraft }]))),
        after: record(row && !('error' in sheet) ? fieldState(sheet, row, names) : Object.fromEntries(saved.map((f) => [f.name, { value: f.to, nexusDraft: true }]))),
      },
    }
  },
}

// ── listing-live-content ───────────────────────────────────────────────────────────────────────────────

const listingLiveInput = z.object({
  product: z.string().trim().min(1).max(191).describe('the product whose listing it is: a Nexus product id or a SKU'),
  channel: z.preprocess(upper, z.enum(COORDINATE_CHANNELS)).describe('AMAZON, EBAY or SHOPIFY (Etsy is not available yet)'),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Shopify'),
  ...accountArgs,
})

const listingLiveContent: AgentTool = {
  name: 'listing-live-content',
  title: 'Listing content on the channel',
  input: listingLiveInput,
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    'What one listing holds on its channel right now, read live (one read per listing per 30 seconds; a repeat inside '
    + 'that window says cached): its text and attributes per variation, the revision, and what could not be read. '
    + 'Compare it with product-content to see what a publish would change. Etsy is not available yet.',
  async handler(args): Promise<ToolResult> {
    const a = args as z.infer<typeof listingLiveInput>
    const named = await liveProductByRef(a.product)
    if (!named) return { ok: false, error: PRODUCT_NOT_FOUND }
    if (a.channel === 'ETSY') return { ok: false, error: ETSY_NOT_YET }
    const where = `${channelLabel(a.channel)} · ${a.market}`
    // The family's listings on this coordinate name its account; one account, or the one asked for.
    const family = named.parentId ?? named.id
    const listings = await prisma.channelListing.findMany({
      where: { channel: a.channel, marketplace: a.market, aliasKey: a.aliasKey ?? '', product: { deletedAt: null, OR: [{ id: family }, { parentId: family }] },
        ...(a.accountId ? { channelConnectionId: a.accountId } : {}) },
      select: { channelConnectionId: true },
    })
    const accounts = [...new Set(listings.map((l) => l.channelConnectionId).filter((id): id is string => !!id))]
    if (!accounts.length) return { ok: false, error: `${named.sku} has no ${where} listing${a.aliasKey ? ` "${a.aliasKey}"` : ''} to read.` }
    if (accounts.length > 1) return { ok: false, error: `${named.sku} is listed on ${where} under ${accounts.length} accounts: name the account (accountId).` }
    const { readLiveListing, publicLiveRead } = await import('../../live-read/index.js')
    let read
    try {
      read = publicLiveRead(await readLiveListing(named.id, { channel: a.channel, marketplace: a.market, accountId: accounts[0], ...(a.aliasKey ? { aliasKey: a.aliasKey } : {}) }))
    } catch (error) {
      const refusal = sheetRefusal(error) ?? ((error as { statusCode?: unknown })?.statusCode ? String((error as Error).message) : null)
      if (refusal) return { ok: false, error: refusal }
      throw error
    }
    return {
      ok: true,
      data: {
        ...read,
        note: read.errors.length
          ? 'Some of it could not be read: see errors. A live read works only in the deployed API (channel logins are sealed there).'
          : 'Read live from the channel; nothing here is stored in Nexus.',
      },
    }
  },
}

export const CHANNEL_CONTENT_TOOLS: AgentTool[] = [shopifyContent, setShopifyContent, listingLiveContent]

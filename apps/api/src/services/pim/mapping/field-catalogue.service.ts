import { loadShopifyProductSpec } from '../channel-specs/shopify.js'
import { mappingToken } from './revision-token.js'
import { registerCatalogueSchema } from './schema-requirements.js'
/**
 * PES.6.1 — the field catalogue: every field a channel category HAS, not just the ones
 * somebody already mapped.
 *
 * Why this exists. `payload-preview` walks `Object.keys(rules)`, so an unmapped field is
 * invisible to it — and "the fields you have not mapped yet" is the entire point of a mapping
 * editor. Rithum shows `Your filters match 119 of 245 total fields`; 245 is the SCHEMA, 119 is
 * what survived the filters, and the unmapped ones are exactly the work. So this returns the
 * UNION of: the channel's schema for the selected category, the `ChannelSchema` rows, and every
 * key that already carries a rule.
 *
 * PRIORITY IS DERIVED FROM AMAZON, NOT INVENTED. Measured on the real cached IT/OUTERWEAR
 * definition 2026-09-01:
 *   - `root.required`          →  7 fields   → `required`
 *   - gated by an `allOf` `if/then` that adds them to `required`
 *                              → 44 fields   → `requiredIfRelevant`
 *   - everything else          → 58 fields   → `optional`
 *   - `minItems >= 1`          → 109 of 109  → NOT a requirement signal. It is array
 *                                              cardinality. Reading it as "required" would
 *                                              mark every field required — a false positive,
 *                                              which is worse than a false negative here
 *                                              (reference_scanner_false_positive_worse).
 * Rithum's fourth level, "Best Practice", has no counterpart in Amazon's schema. It is their
 * editorial layer. We do NOT synthesise it: a field is `bestPractice` only where the channel
 * itself says so (today: never), so the column never claims knowledge we do not have.
 *
 * Schema freshness is REPORTED, never hidden. Reads the CACHED definition whatever its TTL
 * — the same deliberate choice `schema-caps.ts` documents — and hands the age to the UI.
 */

import prisma from '../../../db.js'
import { ALLOWED_MASTER_FIELDS } from '../master-field-gate.js'
import { masterDefaultRule } from './master-default-rule.js'
import { sourceOwner, type SourceOwner } from './source-definition-plan.js'
import { amazonClassificationSpec } from '../channel-specs/amazon.js'
import { loadEtsyProductSpec } from '../channel-specs/etsy-loader.js'
import { loadAmazonSpec, loadAmazonEnglishLabels, loadEbaySpec, clearChannelSpecCache, type ChannelSpec } from '../channel-specs/index.js'
import { englishLeafLabel } from '../sheet-columns.service.js'
import {
  getMappingForMarketplace,
  getRulesFor,
  MarketplaceNotFoundError,
  type FieldMappingRule,
  type MarketplaceSchemaMapping,
} from '../schema-mapping.service.js'

export type FieldPriority = 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'

/** What the "Mapping from Your Data" cell is showing — drives the icon. */
export type RuleKind = 'unmapped' | 'attribute' | 'constant' | 'expression' | 'businessRule'

export interface CatalogueGroup {
  key: string
  /** The channel's own group title, in the channel's language (Amazon localises these). */
  label: string
  description: string | null
  order: number
}

export interface CatalogueField {
  managedBy?: 'productMedia'
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  readOnlyReason?: string

  validation?: Record<string, unknown>
  channelStore?: import('../channel-specs/types.js').ChannelStore
  fieldKey: string
  /** The sheet's base key; lists may expand into numbered columns. */
  sheetKey?: string
  shape?: 'scalar' | 'list' | 'measure'
  kind?: import('../channel-specs/types.js').LeafKind
  requiredInParent?: boolean
  cardinality?: import('../channel-specs/types.js').Cardinality
  unitOptions?: string[]
  label: string
  helpText: string | null
  group: string
  groupOrder: number
  priority: FieldPriority
  /** Where the priority came from, so the UI can be honest about it. */
  prioritySource: 'amazonSchema' | 'channelSchema' | 'ruleFlag' | 'unknown'
  maxLength: number | null
  maxBytes: number | null
  options: string[] | null
  optionLabels: Record<string, string> | null
  /** The schema closes the list — an off-list value is an error, not a warning. */
  selectionOnly: boolean
  /** Amazon `editable: false` — cannot be changed on an EXISTING listing. */
  editable: boolean
  deprecatedOptions: string[] | null
  rule: FieldMappingRule | null
  ruleKind: RuleKind
  /** Exactly what the mapping cell prints (an attribute path, a quoted constant, a formula,
   *  or a business-rule NAME — Rithum shows the name, never the body). */
  ruleSummary: string | null
  /** Set when ruleKind === 'businessRule'. */
  ruleRef: string | null
  /** The rule comes from the productType overlay rather than the default bucket. */
  overlay: boolean
  ruleOrigin?: 'master' | 'default' | 'category' | null
  /** A retained authored rule whose field is absent from the selected schema. */
  schemaKnown?: boolean
  sourceOwner?: SourceOwner | null
  status: 'mapped' | 'unmapped' | 'owned'
}

export interface FieldCatalogue {
  masterSourceKeys?: string[]
  masterLocalizableKeys?: string[]
  mappingToken: string
  mappingVersion: number
  channel: string
  marketplace: string
  /** The channel category whose field set this is (Amazon: the productType). */
  productType: string | null
  /** Overlay product types that already carry rules, for the selector. */
  productTypes: string[]
  schema: {
    source: 'amazonCache' | 'channelSchema' | 'none'
    present: boolean
    fetchedAt: string | null
    ageDays: number | null
    version: string | null
    /** Said out loud when there is no cached definition — the field list is then only as
     *  complete as the ChannelSchema rows, and the UI must say so. */
    note: string | null
  }
  groups: CatalogueGroup[]
  fields: CatalogueField[]
  counts: {
    total: number
    mapped: number
    unmapped: number
    owned: number
    required: number
    requiredUnmapped: number
    /** Shared mappings ÷ fields needing shared mapping. Listing/system sources are separate. */
    coveragePct: number | null
  }
  /** Named business rules available on this marketplace (name → body). */
  expressions: Record<string, string>
}

const UNGROUPED = 'other'

/** The sheet and catalogue use the same schema cache and invalidation. */
export const clearFieldCatalogueCache = clearChannelSpecCache

// ────────────────────────────────────────────────────────────────────
// Rule → what the cell shows
// ────────────────────────────────────────────────────────────────────

function quoted(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`
  return JSON.stringify(v ?? null)
}

/** Classify a rule the way the editor renders it. Pure — exported for the route + tests. */
export function describeRule(rule: FieldMappingRule | null): {
  kind: RuleKind
  summary: string | null
  ref: string | null
} {
  if (!rule) return { kind: 'unmapped', summary: null, ref: null }
  const transforms = rule.transforms ?? []

  const exprOp = transforms.find((t) => t.type === 'expr') as
    | { type: 'expr'; expr?: string; ref?: string }
    | undefined
  if (exprOp?.ref) return { kind: 'businessRule', summary: exprOp.ref, ref: exprOp.ref }
  if (exprOp?.expr) return { kind: 'expression', summary: exprOp.expr, ref: null }

  const templateOp = transforms.find((t) => t.type === 'template') as
    | { type: 'template'; expr: string }
    | undefined
  if (templateOp) return { kind: 'expression', summary: templateOp.expr, ref: null }

  // A constant is an empty source plus a `default` that always fires.
  if (!rule.source) {
    const def = transforms.find((t) => t.type === 'default') as { type: 'default'; value: unknown } | undefined
    if (def) return { kind: 'constant', summary: quoted(def.value), ref: null }
    return { kind: 'unmapped', summary: null, ref: null }
  }

  return { kind: 'attribute', summary: rule.source, ref: null }
}

// ────────────────────────────────────────────────────────────────────
// The catalogue
// ────────────────────────────────────────────────────────────────────

export async function getFieldCatalogue(input: {
  locale?: string
  accountId?: string | null

  channel: string
  marketplace: string
  /** The channel category (Amazon productType). Omit for the default bucket. */
  productType?: string | null
  /** A reviewed draft is evaluated in memory by the same field catalogue. */
  mappingSnapshot?: MarketplaceSchemaMapping
}): Promise<FieldCatalogue> {
  const channel = input.channel.toUpperCase()
  const marketplace = input.marketplace
  const productType = channel === 'SHOPIFY' ? null : input.productType?.trim() || null

  let mapping: MarketplaceSchemaMapping
  try {
    mapping = input.mappingSnapshot ?? await getMappingForMarketplace(channel, marketplace)
  } catch (err) {
    if (err instanceof MarketplaceNotFoundError) throw err
    throw err
  }
  const rules = getRulesFor(mapping, productType)
  const customAttributes = await prisma.customAttribute.findMany({ select: { code: true, localizable: true } })
  const masterKeys = new Set([...ALLOWED_MASTER_FIELDS, ...customAttributes.map(a => a.code)])
  const overlayKeys = new Set(
    productType ? Object.keys(mapping.byProductType?.[productType] ?? {}) : [],
  )

  // ── ChannelSchema rows: this channel's marketplace-specific + agnostic fields ──
  const schemaRows = await prisma.channelSchema.findMany({
    where: { channel, OR: [{ marketplace }, { marketplace: null }] },
    orderBy: { fieldKey: 'asc' },
  })

  // Use the sheet's adapter: scalar, list, measure AND every compound leaf.
  // The old scalar-cap extractor silently omitted compound fields from this page.
  const schemaSpec: ChannelSpec | null = channel === 'AMAZON' && productType
    ? await loadAmazonSpec(marketplace, productType, input.accountId)
    : channel === 'EBAY'
      ? await loadEbaySpec(marketplace, productType ? [productType] : [])
      : channel === 'SHOPIFY' ? await loadShopifyProductSpec(input.accountId, input.locale) : channel === 'ETSY' ? await loadEtsyProductSpec(productType, input.locale) : null
  const classification = channel === 'AMAZON' ? amazonClassificationSpec(marketplace) : null
  const spec: ChannelSpec | null = classification ? {
    ...(schemaSpec ?? { ...classification, absent: true }),
    fields: [...classification.fields, ...(schemaSpec?.fields ?? []).filter(field => field.key !== 'productType')],
    groups: [...classification.groups, ...(schemaSpec?.groups ?? [])],
  } : schemaSpec
  const specFields = new Map(spec?.fields.map((f) => [f.key, f]) ?? [])
  const englishLabels = channel === 'AMAZON' && productType ? await loadAmazonEnglishLabels(productType) : undefined
  const groups: CatalogueGroup[] = (spec?.groups ?? []).map((g) => ({
    key: g.key, label: g.label, description: null, order: g.order,
  }))
  const ageDays = spec?.fetchedAt ? Math.floor((Date.now() - spec.fetchedAt.getTime()) / 86_400_000) : null
  const present = !!spec && !spec.absent
  const schemaMeta: FieldCatalogue['schema'] = {
    source: present && channel === 'AMAZON' ? 'amazonCache' : schemaRows.length > 0 || present ? 'channelSchema' : 'none',
    present: spec ? present : schemaRows.length > 0,
    fetchedAt: spec?.fetchedAt?.toISOString() ?? null,
    ageDays,
    version: spec?.schemaVersion ?? null,
    note: channel === 'SHOPIFY' ? input.accountId ? 'Native attributes and live definitions from the selected Shopify store. Store references require verified Shopify identities.' : 'Native Shopify attributes. Select a connected store to load its metafields.'
      : channel === 'ETSY'
      ? !productType ? 'Etsy listing fields. Select a seller taxonomy category to load its attributes and requirements.'
        : spec?.absent ? 'Etsy category requirements are missing. Refresh requirements in the channel sheet before confirming readiness.'
          : 'Etsy listing fields and the selected seller taxonomy category. Read-only fields are reported by Etsy; variation inventory uses its own resource.'
      : spec?.absent
      ? `No cached ${channel} definition for ${productType ?? 'this category'} on ${marketplace}. Only stored field definitions and existing rules are shown.`
      : !present && schemaRows.length === 0
        ? `No field definitions are stored for ${channel} · ${marketplace}. Run a schema sync to see the full field set.`
        : ageDays !== null && ageDays > 1
          ? `${channel}'s definition was cached ${ageDays} days ago.`
          : null,
  }

  // ── Build the union ──────────────────────────────────────────────
  const byKey = new Map<string, CatalogueField>()
  // Market-specific definitions win regardless of database tie ordering.
  const rowByKey = new Map([...schemaRows].sort((a, b) => Number(a.marketplace === marketplace) - Number(b.marketplace === marketplace)).map((r) => [r.fieldKey, r]))

  const priorityFor = (
    key: string,
  ): { priority: FieldPriority; source: CatalogueField['prioritySource'] } => {
    const field = specFields.get(key)
    if (field) return { priority: field.requirement, source: channel === 'AMAZON' && key !== 'productType' ? 'amazonSchema' : 'channelSchema' }
    const row = rowByKey.get(key)
    if (row) return { priority: row.required ? 'required' : 'optional', source: 'channelSchema' }
    // Only the rule itself claims it — say so rather than implying schema knowledge.
    if (rules[key]?.required) return { priority: 'required', source: 'ruleFlag' }
    return { priority: 'optional', source: 'unknown' }
  }

  const put = (key: string, seed: Partial<CatalogueField>) => {
    if (byKey.has(key)) {
      Object.assign(byKey.get(key)!, Object.fromEntries(Object.entries(seed).filter(([, v]) => v != null)))
      return
    }
    const cap = specFields.get(key)
    const owner = cap ? sourceOwner(cap) : null
    const rule = rules[key] ?? masterDefaultRule(cap, masterKeys)
    const described = describeRule(rule)
    const row = rowByKey.get(key)
    const grp = cap?.group
    const { priority, source } = priorityFor(key)
    byKey.set(key, {
      fieldKey: key,
      ...(cap ? { sheetKey: cap.managedBy ?? cap.masterKey ?? cap.key, managedBy: cap.managedBy, requiredInParent: cap.requiredInParent, shape: cap.shape, kind: cap.kind, cardinality: cap.cardinality, unitOptions: cap.unitOptions, channelStore: cap.channelStore, validation: cap.validation, shopifyField: cap.shopifyField, readOnlyReason: cap.readOnlyReason } : {}),
      label: seed.label ?? (cap ? englishLeafLabel(cap, englishLabels) : row?.label ?? key),
      helpText: seed.helpText ?? cap?.helpText ?? row?.notes ?? null,
      group: grp?.key ?? UNGROUPED,
      groupOrder: grp?.order ?? 999,
      priority,
      prioritySource: source,
      maxLength: cap?.maxLength ?? row?.maxLength ?? null,
      maxBytes: cap?.maxBytes ?? null,
      options: cap?.options ?? (Array.isArray(row?.allowedValues) ? (row!.allowedValues as string[]) : null),
      optionLabels: cap?.optionLabels ?? null,
      selectionOnly: cap?.mode === 'strict',
      editable: cap?.editable !== false,
      deprecatedOptions: cap?.deprecatedOptions ?? null,
      rule,
      ruleKind: described.kind,
      ruleSummary: described.summary,
      ruleRef: described.ref,
      overlay: overlayKeys.has(key),
      ruleOrigin: rules[key] ? (overlayKeys.has(key) ? 'category' : 'default') : rule ? 'master' : null,
      schemaKnown: present ? specFields.has(key) : rowByKey.has(key) || specFields.has(key),
      sourceOwner: owner,
      status: rule ? 'mapped' : owner ? 'owned' : 'unmapped',
      ...seed,
    } as CatalogueField)
  }

  for (const key of specFields.keys()) put(key, {})
  // A complete category adapter owns its field set. Generic rows contain other categories,
  // obsolete compound roots and legacy eBay aliases; unioning them invents required gaps.
  if (!present) for (const r of rowByKey.values()) if (!byKey.has(r.fieldKey)) put(r.fieldKey, { label: r.label })
  // Rule keys the schema does not know about — a mapping that outlived its schema field.
  // They stay VISIBLE (deleting an operator's rule silently would be the worse failure).
  for (const key of Object.keys(rules)) {
    // Definition rules remain in storage, but only live fields in this store enter its catalogue.
    if (channel === 'SHOPIFY' && key.startsWith('shopify_metafield:') && (key.split(':')[1] !== encodeURIComponent(input.accountId ?? '') || !specFields.has(key))) continue
    put(key, {})
  }

  if (groups.length === 0 && byKey.size > 0) {
    groups.push({ key: UNGROUPED, label: 'All fields', description: null, order: 0 })
  } else if ([...byKey.values()].some((f) => f.group === UNGROUPED)) {
    groups.push({ key: UNGROUPED, label: 'Other', description: null, order: 999 })
  }

  const fields = [...byKey.values()].sort(
    (a, b) => a.groupOrder - b.groupOrder || a.label.localeCompare(b.label),
  )

  const total = fields.length
  const mapped = fields.filter((f) => f.status === 'mapped').length
  const owned = fields.filter((f) => f.status === 'owned').length
  const required = fields.filter((f) => f.priority === 'required').length
  const requiredUnmapped = fields.filter((f) => f.priority === 'required' && f.status === 'unmapped').length

  const catalogue: FieldCatalogue = {
    masterSourceKeys: [...masterKeys, 'title', 'sku'],
    masterLocalizableKeys: customAttributes.filter(a => a.localizable).map(a => a.code),
    mappingToken: mappingToken(mapping), mappingVersion: mapping.version,
    channel,
    marketplace,
    productType,
    productTypes: Object.keys(mapping.byProductType ?? {}).sort(),
    schema: schemaMeta,
    groups: groups.sort((a, b) => a.order - b.order),
    fields,
    counts: {
      total,
      mapped,
      unmapped: total - mapped - owned,
      owned,
      required,
      requiredUnmapped,
      coveragePct: total > owned ? Math.round((mapped / (total - owned)) * 100) : null,
    },
    expressions: mapping.expressions ?? {},
  }
  registerCatalogueSchema(catalogue, spec)
  return catalogue
}

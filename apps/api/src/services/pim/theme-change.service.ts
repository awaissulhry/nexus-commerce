/**
 * VT.4 — the DRY-RUN theme-change plan (`docs/2026-09-13-variation-theme-column-design.md` §3.5 + D-VT6,
 * `docs/2026-09-12-variation-projection-design.md` §9 + D8).
 *
 * ## What this is, and the one thing it is not
 *
 * A SET change on a LIVE coordinate is not a cell edit. Amazon cannot re-theme a parent in place (its own 2025
 * procedure is: new parent, relink every child, delete the old parent — parent/child theme mismatch is an
 * 8541-class refusal); eBay must END and RELIST; Shopify can do it in place but only through the option
 * mutations with a variant strategy. So the column's commit on a locked coordinate opens THIS — a plan the
 * operator reads, not a write.
 *
 * 🔴 **`dryRun: true` is the only accepted value, and there is NO executor in this programme** (D-VT6 / VX D8).
 * Nothing in this module constructs a provider request: it imports no channel client, no `fetch`, no SP-API or
 * eBay or Shopify transport. Its only I/O is the projection READ and two catalogue reads (the cached
 * `CategorySchema` row behind `loadAmazonThemeFacts`, and one `Product.sku` scan to pick an unused parent SKU).
 * `theme-change.vitest.test.ts` pins that with a counting `fetch`/`http.request` stub AND a positive control
 * that does fire, in the same run.
 *
 * ## Built from the publish path's OWN composers — never a second one
 *
 * VX §8's rule: "A test pins preview payload ≡ live payload: the same function is called with `dryRun: true`,
 * and the test fails if a second composer appears." What that cost, measured 2026-09-13:
 *
 *  - **Amazon child payload** — `AmazonPublishAdapter#buildChildAttributes`. It was `private`; VT.4 made it
 *    public and changed nothing else (see its docblock). The plan's step-2 payload IS its output.
 *  - **eBay specifics** — `resolveVariationAxes` + `buildVariesBySpecifications` from
 *    `ebay-variation-push.service.ts`, the two pure functions the inventory-group PUT itself calls.
 *  - **Shopify options** — `buildShopifyProductOptions`, which VT.4 extracted verbatim out of
 *    `publishContent`'s body so that the publish path and the plan share one expression.
 *
 * 🔴 **Three things have NO composer to reuse, and the plan says so rather than inventing one:**
 *  1. Amazon's PARENT envelope. Measured: `submission.service.ts` never writes `variation_theme` or
 *     `parentage_level` into the parent's attributes at all (`amazonAttributes`, ~:1189-1340) — only the CHILD
 *     payload carries them, from the adapter. So step 1 names the new parent SKU and the theme; it does not
 *     publish a payload it cannot pin against live code.
 *  2. eBay's inventory-group envelope is an inline object literal (`ebay-variation-push.service.ts:1605`).
 *     The plan carries the `specifications` it pins and names the rest.
 *  3. Shopify's `productOptionsCreate` / `productOptionUpdate` / `productOptionsDelete` **do not exist in this
 *     codebase** (0 occurrences outside the web design mock's fixture strings). The plan NAMES the three
 *     mutations and their constraints, and pins only the option list.
 */
import { orderedVariationMapping } from '@nexus/shared/variation-mapping'
import prisma from '../../db.js'
import { AmazonPublishAdapter } from '../listing-wizard/amazon-publish.adapter.js'
import { buildShopifyProductOptions, shopifyOptionAxes } from '../shopify/content-publisher.js'
import { buildVariesBySpecifications, resolveVariationAxes } from '../ebay-variation-push.service.js'
import {
  getProjectionRead,
  previewProjectionMapping,
  ProjectionConflictError,
  ProjectionRequestError,
  type ProjectionInput,
  type ProjectionRead,
} from './family-projection.service.js'
import { loadAmazonThemeFacts } from './variation-theme-facts.js'
import { channelDisplayName } from './variation-rules.service.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export type ThemeChangeKind = 'amazon-new-parent' | 'ebay-relist' | 'shopify-in-place'

export interface ThemeChangeStep {
  n: number
  /** The HTTP-ish verb as the canvas prints it: `PUT`, `PATCH ×20`, `WAIT 8 s`, `DELETE`, `END`, `RELIST`. */
  verb: string
  target: string
  detail: string
  /**
   * `true` / `false` as the canvas's green `yes` / red `no`; `null` renders the muted `—` for a step that is
   * neither (a wait is not an action that could be undone).
   */
  reversible: boolean | null
  /**
   * The EXACT bytes this step would send, when a publish-path composer could produce them, else absent.
   * Absent is a statement: "this repository has no composer for this request, so the plan will not invent one."
   */
  payload?: unknown
}

export interface ThemeChangePlan {
  kind: ThemeChangeKind
  coordinate: { channel: string; market: string; accountId: string | null; aliasKey: string; label: string }
  /** `Change variation theme · Amazon · DE` — Appendix C's menu verb, with the coordinate. */
  title: string
  /** `GALE-JACKET · 20 children · SIZE/COLOR → COLOR/SIZE` */
  subline: string
  from: string
  to: string
  /** The dry-run Banner sentence, server-stated so both hosts say the same thing. */
  banner: string
  steps: ThemeChangeStep[]
  keeps: string[]
  loses: string[]
  /**
   * What the LIVE run would refuse or warn about, verbatim from the adapter that would refuse it. An empty
   * list is a measured empty: every composer ran and reported nothing.
   */
  warnings: string[]
  /** Always `true` in this programme. There is no executor; a `false` never reaches this module. */
  dryRun: true
  meta: {
    tookMs: number
    /** Which publish-path composer produced the pinned payload(s). */
    adapter: string
    /** Provider calls made while building this plan. Structurally zero — see the module docblock. */
    providerCalls: 0
  }
}

export interface ThemeChangeInput extends ProjectionInput {
  /** The parent `ChannelListing.version` the operator saw, exactly as the projection PATCH takes it. */
  expectedVersion: number
  /** Optional. When sent it must MATCH the coordinate's channel — an explicit flag that contradicts the world is refused, not reinterpreted. */
  kind?: string
  /** AMAZON only: the target theme enum value. Required there. */
  theme?: string | null
  /** The target axis SET, in delivery order. Required on eBay/Shopify; optional on Amazon (the theme decides). */
  mapping?: Array<{ axisKey: string; target: string; order?: number }>
  reset?: boolean
  dryRun: true
}

/** The plan's own copy, in one place. Appendix A (VT) + Appendix C (VX), verbatim. */
export const PLAN_COPY = {
  title: (channelLabel: string, market: string) => `Change variation theme · ${channelLabel} · ${market}`,
  amazonBanner:
    'Dry run — nothing is sent. Amazon does not change a theme in place: the parent is replaced and the children relinked. The live run is a separate approval and the Owner runs the first one.',
  ebayBanner:
    'Dry run — nothing is sent. eBay cannot change a variation set in place: the item is ended and relisted under a new ItemID. The live run is a separate approval and the Owner runs the first one.',
  shopifyBanner:
    'Dry run — nothing is sent. Shopify changes options in place, but every option must stay used by at least one variant and positions must stay sequential. The live run is a separate approval and the Owner runs the first one.',
  adapterNote: 'Plan built by the same adapter the publish path calls',
  copyPlan: 'Copy plan',
  close: 'Close',
  columns: { n: '#', verb: 'Verb', target: 'Target', detail: 'Detail', reversible: 'Reversible' },
  keeps: 'Keeps',
  loses: 'Loses',
} as const

const AMAZON_KEEPS = [
  'child ASINs, reviews and sales history',
  'offers, prices, FBA stock',
  'the Nexus product and its children',
]
const EBAY_KEEPS = ['SKUs and EANs', 'prices and stock, echoed onto the new item', 'the Nexus product and its children']
const EBAY_LOSES = ['the ItemID and its URL', 'watchers and the item’s sales history', 'best-match age']

/**
 * `<parentSku>-P<n>` — the first n ≥ 2 that no PRODUCT SKU already uses.
 *
 * n starts at 2, not 1: the parent being replaced is the family's first, so the canvas reads `GALE-JACKET-P2`.
 * The scan is a `startsWith` read rather than a counter, because a counter would hand out a SKU a previous
 * (possibly abandoned) re-theme already took.
 *
 * 🔴 It can only scan PRODUCT SKUs, and the plan says so rather than implying more: measured 2026-09-13,
 * `ChannelListing` has **no SKU column at all** (`information_schema`: zero columns matching `%sku%`) — the
 * channel SKU is DERIVED at submission time by `submission.service.ts#applySkuStrategy` (`<master>` or
 * `<master>-<MARKET>`), so there is no stored set of marketplace SKUs to check against. A marketplace SKU that
 * exists on Amazon but not in this catalogue would therefore not be seen here; the live executor (a separate
 * approval, D-VT6) has to confirm the new parent SKU against SP-API before it PUTs, and that is recorded as
 * this plan's boundary rather than papered over.
 */
export async function nextParentSku(parentSku: string): Promise<string> {
  const prefix = `${parentSku}-P`
  const products = await prisma.product.findMany({ where: { sku: { startsWith: prefix } }, select: { sku: true } })
  const taken = new Set<string>(products.map((p) => p.sku))
  let n = 2
  while (taken.has(`${prefix}${n}`)) n += 1
  return `${prefix}${n}`
}

/** The theme string the coordinate carries today, or `—` when it carries none. */
function currentThemeOf(read: ProjectionRead): string | null {
  return read.theme?.value?.trim() ? read.theme.value.trim() : null
}

/** The delivery-ordered axis SET, as the channel receives it. */
function setOf(entries: Array<{ axisKey: string; target: string | null; order: number }>): string[] {
  return [...entries]
    .filter((e) => !!e.target)
    .sort((a, b) => a.order - b.order)
    .map((e) => e.target as string)
}

function kindForChannel(channel: string): ThemeChangeKind {
  const upper = channel.toUpperCase()
  if (upper === 'AMAZON') return 'amazon-new-parent'
  if (upper === 'EBAY') return 'ebay-relist'
  if (upper === 'SHOPIFY') return 'shopify-in-place'
  throw new ProjectionRequestError(
    `${channelDisplayName(upper)} has no theme-change operation in this programme — only Amazon, eBay and Shopify do.`,
    { channel: upper },
  )
}

/**
 * Build the plan. READ-ONLY: no write of any kind, no provider call, no queue row.
 *
 * The CAS token is still required and still checked, for a reason worth stating: a plan computed against a
 * version the operator no longer has describes a world that moved, and the operator would read it as current.
 * A 409 here carries the fresh read exactly as the PATCH's does.
 */
export async function buildThemeChangePlan(input: ThemeChangeInput): Promise<ThemeChangePlan> {
  const t0 = Date.now()
  if (input.dryRun !== true) {
    throw new ProjectionRequestError(
      'dryRun must be true. There is no live theme-change executor in this programme — the plan is what this endpoint returns.',
    )
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ProjectionRequestError('An observed listing version is required.')
  }

  const read = await getProjectionRead(input)
  if (read.version !== input.expectedVersion) {
    throw new ProjectionConflictError(
      'version_conflict',
      'This listing changed after you opened the mapping. Reload it and review the change again.',
      { current: read },
    )
  }

  const channel = read.coordinate.channel.toUpperCase()
  const kind = kindForChannel(channel)
  if (input.kind !== undefined && input.kind !== kind) {
    // reference_explicit_flag_beats_inference, the other way round: an explicit flag that CONTRADICTS the
    // coordinate is a caller mistake, and silently using the coordinate's own kind would run a different
    // operation from the one the caller asked for.
    throw new ProjectionRequestError(
      `A ${read.coordinate.channelLabel} coordinate's theme change is "${kind}", and this request asked for "${input.kind}".`,
      { kind },
    )
  }

  if (input.reset) {
    if (input.mapping !== undefined || input.theme !== undefined) throw new ProjectionRequestError('Send reset on its own.')
    const inherited = await previewProjectionMapping({ ...input, reset: true })
    if (inherited.version !== read.version) throw new ProjectionConflictError('version_conflict', 'Reload the listing before reviewing its reset.')
    input = { ...input, reset: undefined, theme: inherited.theme?.value ?? null, mapping: inherited.mapping.filter(m => m.target).map(m => ({ axisKey: m.axisKey, target: m.target!, order: m.order })) }
  }
  const included = read.children.filter((c) => c.included)
  const requested = input.mapping
    ? input.mapping.map((m, i) => ({ axisKey: m.axisKey, target: m.target, order: m.order ?? i }))
    : read.mapping.filter((m) => m.target).map((m) => ({ axisKey: m.axisKey, target: m.target as string, order: m.order }))
  for (const entry of requested) {
    if (!read.mapping.some((m) => canonicalVariantAxis(m.axisKey) === canonicalVariantAxis(entry.axisKey))) {
      throw new ProjectionRequestError(
        `"${entry.axisKey}" is not one of this family's axes. Add it on the shared product first.`,
        { axes: read.mapping.map((m) => m.axisKey) },
      )
    }
  }

  const before = setOf(read.mapping)
  const after = setOf(requested)
  const label = read.coordinate.label
  const title = PLAN_COPY.title(read.coordinate.channelLabel, read.coordinate.market)

  if (kind === 'amazon-new-parent') {
    const theme = (input.theme ?? '').trim()
    if (!theme) {
      throw new ProjectionRequestError(
        'An Amazon theme change needs the theme it changes TO. Send `theme` with one of this product type’s variation themes.',
      )
    }
    const offered = read.theme?.options ?? []
    if (offered.length > 0 && !offered.some((o) => o.code === theme)) {
      throw new ProjectionRequestError(
        `"${theme}" is not one of the ${offered.length} variation themes this product type offers on ${read.coordinate.market}.`,
        { themeOptions: offered.map((o) => o.code) },
      )
    }
    const current = currentThemeOf(read)
    if (current === theme) {
      throw new ProjectionRequestError(
        `This coordinate already carries ${theme}, so there is nothing to plan. Change the theme first, or save the order through the mapping instead.`,
      )
    }
    return await amazonPlan({ read, input, theme, current, included, requested, title, t0 })
  }

  if (kind === 'ebay-relist') {
    // VX §9: "Only when the SET changes; order and added values are a revise and never reach this plan."
    const sameSet = before.length === after.length && after.every((name) => before.includes(name))
    if (sameSet) {
      throw new ProjectionRequestError(
        'Reordering an eBay listing’s specifics, or adding values to them, is a revise — not a relist. Save it through the mapping instead; this plan exists only for a change to the SET.',
        { before, after },
      )
    }
    return ebayPlan({ read, included, requested, before, after, title, label, t0 })
  }

  return shopifyPlan({ read, included, requested, before, after, title, t0 })
}

// ────────────────────────────────────────────────────────────────────
// amazon-new-parent
// ────────────────────────────────────────────────────────────────────

async function amazonPlan(args: {
  read: ProjectionRead
  input: ThemeChangeInput
  theme: string
  current: string | null
  included: ProjectionRead['children']
  requested: Array<{ axisKey: string; target: string; order: number }>
  title: string
  t0: number
}): Promise<ThemeChangePlan> {
  const { read, theme, current, included, requested, title, t0 } = args
  const market = read.coordinate.market
  const marketplaceId = await amazonMarketplaceId(market)
  const newParentSku = await nextParentSku(read.parent.sku)

  // The product type's own `properties`, from the LATEST cached schema row — the same reader the publish path
  // uses, and a database read, never a provider call (T13/T17: every prod row is expired and expiry is not
  // consulted, because absence is the only thing that would reach a provider).
  const productType = read.coordinate.category !== undefined ? read.coordinate.category : await productTypeOf(read.parent.id)
  const facts = productType ? await loadAmazonThemeFacts(marketplaceId, productType) : null
  const schemaProperties = facts ? (facts.facts.properties as Record<string, unknown>) : null

  // The `variationMapping` the publish path reads — built the way `writeProjectionMapping` stores it (R-VT-13:
  // the ORDERED shape), so the plan's binding is the binding a save would produce. The adapter reads either
  // shape through `@nexus/shared/variation-mapping`, so this is the same lookup the live path performs.
  const plannedMapping = orderedVariationMapping(requested.map((entry, index) => ({ axisKey: entry.axisKey, target: entry.target, order: index })))

  const adapter = new AmazonPublishAdapter()
  const warnings: string[] = []
  // The FIRST included child is the sample: every child's payload differs only in its axis values, and a plan
  // that printed twenty identical envelopes would hide the one thing that varies.
  const sample = included[0] ?? null
  const built = sample
    ? adapter.buildChildAttributes({
      parentSku: newParentSku,
      marketplaceId,
      variationTheme: theme,
      variationAttributes: sample.projectedAxisValues ?? sample.sharedAxisValues,
      variationMapping: plannedMapping,
      schemaProperties,
      price: null,
      quantity: null,
    })
    : null
  if (built && built.unbound.length > 0) {
    // The live path REFUSES on this (`amazon-publish.adapter.ts`, VT.1). Saying so on the plan is the whole
    // point of building it from the adapter: the refusal is discovered before the operation, not during it.
    const named = built.unbound.map((u) => (u.segment ? `${u.axis} (theme segment ${u.segment})` : u.axis)).join(', ')
    warnings.push(
      `The live run would be REFUSED before the first parent or child PUT: ${named} binds to no attribute of product type ${productType ?? '(unknown)'} on ${marketplaceId}. Map ${built.unbound.length === 1 ? 'it' : 'them'} on the Variation theme column first.`,
    )
  }
  if (built && built.uncheckable.length > 0) {
    warnings.push(
      `The live run could not check ${built.uncheckable.join(', ')} against product type ${productType ?? '(unknown)'} and would refuse before publishing: no cached CategorySchema row answers for marketplace "${marketplaceId}" (the AMAZON rows are keyed by market code, e.g. "${market}").`,
    )
  }
  if (!sample) warnings.push('No variant is included on this coordinate, so there is no child payload to show.')
  if ((read.theme?.options ?? []).length === 0) {
    // 🔴 COULD NOT LOOK, not "the theme is fine". An empty option list is the third state
    // `reference_could_not_measure_vs_measured_empty` names, and a plan that silently accepted any string
    // would be asserting Amazon offers it.
    warnings.push(
      `This coordinate offers no readable variation-theme list, so "${theme}" was NOT checked against the product type's enum. Refresh the ${productType ?? 'product type'} requirements for ${market} before the live run.`,
    )
  }

  const boundAttributes = built
    ? Object.keys(built.attributes).filter((k) => k !== 'parentage_level' && k !== 'child_parent_sku_relationship' && k !== 'variation_theme' && k !== 'purchasable_offer')
    : []
  const oldParentId = read.parent.listing.externalId

  const steps: ThemeChangeStep[] = [
    {
      n: 1,
      verb: 'PUT',
      target: newParentSku,
      detail: `New parent with theme ${theme} on ${market}`,
      reversible: true,
    },
    {
      n: 2,
      verb: `PATCH ×${included.length}`,
      target: 'every child',
      detail: `child_parent_sku_relationship → ${newParentSku} · variation_theme → ${theme}${boundAttributes.length ? ` · ${boundAttributes.join(', ')}` : ''}`,
      reversible: true,
      ...(built ? { payload: built.attributes } : {}),
    },
    {
      n: 3,
      verb: 'WAIT 8 s',
      target: 'read-back',
      detail: 'Every child reads the new parent from Amazon before step 4 runs',
      reversible: null,
    },
    {
      n: 4,
      verb: 'DELETE',
      target: oldParentId ? `${read.parent.sku} (${oldParentId})` : read.parent.sku,
      detail: `Old parent listing item on ${market}`,
      reversible: false,
    },
  ]

  return {
    kind: 'amazon-new-parent',
    coordinate: coordinateOf(read),
    title,
    subline: `${read.parent.sku} · ${included.length} ${included.length === 1 ? 'child' : 'children'} · ${current ?? '—'} → ${theme}`,
    from: current ?? '—',
    to: theme,
    banner: PLAN_COPY.amazonBanner,
    steps,
    keeps: AMAZON_KEEPS,
    loses: [
      oldParentId ? `the parent ASIN ${oldParentId} and its URL` : 'the parent listing item and its URL',
      'A+ content attached to the parent',
      oldParentId ? `ads targeting the parent ASIN ${oldParentId}` : 'ads targeting the parent',
    ],
    warnings,
    dryRun: true,
    meta: { tookMs: Date.now() - t0, adapter: 'AmazonPublishAdapter#buildChildAttributes', providerCalls: 0 },
  }
}

/** The family root's product type — one narrow read, for the cached-schema lookup only. */
async function productTypeOf(productId: string): Promise<string | null> {
  const row = await prisma.product.findUnique({ where: { id: productId }, select: { productType: true } })
  return row?.productType ?? null
}

/**
 * The SP-API marketplace id, resolved EXACTLY as the publish path resolves it
 * (`submission.service.ts:186-195`): `Marketplace.marketplaceId` for `(AMAZON, code)`, and the bare market code
 * when that column is empty. Measured on the local catalogue: `IT → APJ6JRA9NG5V4`, `DE → A1PA6795UKMFR9`.
 *
 * 🔴 It is deliberately NOT `marketplaceIdFor()` from `variation-theme-segments.ts`: that helper is the eBay
 * `__lastPublishedAxes` key rule and returns the bare code for Amazon. Using it here would have printed
 * `marketplace_id: "IT"` in a plan whose live counterpart sends `APJ6JRA9NG5V4` — a plan that lies about the
 * payload in the one field every attribute carries.
 */
async function amazonMarketplaceId(market: string): Promise<string> {
  const code = String(market ?? '').toUpperCase()
  const row = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code }, select: { marketplaceId: true } })
  const id = row?.marketplaceId ?? ''
  return id.length > 0 ? id : code
}

// ────────────────────────────────────────────────────────────────────
// ebay-relist
// ────────────────────────────────────────────────────────────────────

function ebayPlan(args: {
  read: ProjectionRead
  included: ProjectionRead['children']
  requested: Array<{ axisKey: string; target: string; order: number }>
  before: string[]
  after: string[]
  title: string
  label: string
  t0: number
}): ThemeChangePlan {
  const { read, included, requested, before, after, title, t0 } = args
  const ordered = [...requested].sort((a, b) => a.order - b.order)

  /**
   * The push composes its specifics from flat-file style rows keyed `aspect_<AspectName>`
   * (`axisValueOfRow`, `resolveVariationAxes`). Projecting the read's children into that shape is a mapping of
   * the INPUT, not a second composer of the output — the output is `buildVariesBySpecifications`, verbatim.
   */
  const rows = included.map((child) => {
    const row: Record<string, unknown> = { sku: child.sku }
    for (const entry of ordered) {
      const value = child.sharedAxisValues?.[entry.axisKey]
      if (value) row[`aspect_${entry.target.replace(/ /g, '_')}`] = value
    }
    return row
  })
  const resolved = resolveVariationAxes(rows, after, { storedAxisOrder: after })
  const specifications = buildVariesBySpecifications(
    resolved.validSpecs,
    read.order?.valueOrder ?? {},
    rows.map((r) => r.sku as string).filter(Boolean),
  )
  const itemId = read.parent.listing.externalId
  const aliasLabel = read.coordinate.aliasKey
    ? (read.split.listings.find((l) => l.aliasKey === read.coordinate.aliasKey)?.label ?? read.coordinate.aliasKey)
    : 'Primary listing'

  const steps: ThemeChangeStep[] = [
    {
      n: 1,
      verb: 'END',
      target: itemId ? `item ${itemId}` : aliasLabel,
      detail: `Ends the live ${read.coordinate.market} listing. Its ItemID is not reusable.`,
      reversible: false,
    },
    {
      n: 2,
      verb: 'RELIST',
      target: aliasLabel,
      detail: `New item with the specifics ${after.join(' · ')}${before.length ? ` (was ${before.join(' · ')})` : ''}`,
      reversible: false,
      payload: { variesBy: { specifications } },
    },
    {
      n: 3,
      verb: 'WAIT 8 s',
      target: 'read-back',
      detail: 'The new ItemID is read back and stored on this coordinate before anything else runs',
      reversible: null,
    },
    {
      n: 4,
      verb: 'PATCH',
      target: 'this listing record',
      detail: 'externalListingId → the new ItemID; the old one is kept in the listing history',
      reversible: true,
    },
  ]
  const warnings: string[] = [...resolved.warnings]
  if (resolved.validSpecs.length === 0) {
    warnings.push(
      'No axis survives with more than one value on this coordinate, so eBay would receive the Custom Bundle fallback rather than a variation set.',
    )
  }

  return {
    kind: 'ebay-relist',
    coordinate: coordinateOf(read),
    title,
    subline: `${read.parent.sku} · ${included.length} ${included.length === 1 ? 'variation' : 'variations'} · ${before.join(' · ') || '—'} → ${after.join(' · ') || '—'}`,
    from: before.join(' · ') || '—',
    to: after.join(' · ') || '—',
    banner: PLAN_COPY.ebayBanner,
    steps,
    keeps: EBAY_KEEPS,
    loses: EBAY_LOSES,
    warnings,
    dryRun: true,
    meta: {
      tookMs: Date.now() - t0,
      adapter: 'ebay-variation-push.service#resolveVariationAxes + buildVariesBySpecifications',
      providerCalls: 0,
    },
  }
}

// ────────────────────────────────────────────────────────────────────
// shopify-in-place
// ────────────────────────────────────────────────────────────────────

function shopifyPlan(args: {
  read: ProjectionRead
  included: ProjectionRead['children']
  requested: Array<{ axisKey: string; target: string; order: number }>
  before: string[]
  after: string[]
  title: string
  t0: number
}): ThemeChangePlan {
  const { read, included, requested, before, after, title, t0 } = args
  const ordered = [...requested].sort((a, b) => a.order - b.order)
  const axes = ordered.map((e) => e.target)
  const variants = included.map((child) => ({
    options: Object.fromEntries(ordered.map((e) => [e.target, child.sharedAxisValues?.[e.axisKey] ?? ''])),
  }))
  const productOptions = buildShopifyProductOptions(axes, variants)

  const added = after.filter((name) => !before.includes(name))
  const removed = before.filter((name) => !after.includes(name))
  const kept = after.filter((name) => before.includes(name))

  const steps: ThemeChangeStep[] = []
  let n = 0
  for (const name of added) {
    const option = productOptions.find((o) => o.name === name)
    steps.push({
      n: ++n,
      verb: 'productOptionsCreate',
      target: name,
      detail: `Every existing variant gets a value on ${name} (${option ? option.values.map((v) => v.name).filter(Boolean).join(', ') : 'no values on this coordinate'}) — Shopify requires it`,
      reversible: true,
      payload: option ?? null,
    })
  }
  for (const name of kept) {
    const option = productOptions.find((o) => o.name === name)
    steps.push({
      n: ++n,
      verb: 'productOptionUpdate',
      target: name,
      detail: `position → ${option?.position ?? '?'}; values ${option ? option.values.map((v) => v.name).filter(Boolean).join(', ') : '—'}`,
      reversible: true,
      payload: option ?? null,
    })
  }
  for (const name of removed) {
    steps.push({
      n: ++n,
      verb: 'productOptionsDelete',
      target: name,
      detail: 'Needs a variant strategy: Shopify must be told what to do with the variants this option told apart',
      reversible: false,
    })
  }
  steps.push({
    n: ++n,
    verb: 'WAIT 8 s',
    target: 'read-back',
    detail: 'The product is read back and its options compared with this plan before the change is recorded',
    reversible: null,
  })

  const warnings: string[] = [
    'Shopify’s productOptionsCreate / productOptionUpdate / productOptionsDelete are not implemented in this codebase — the option list below is the one the productSet publish sends, and the three mutations are named, not composed.',
  ]
  if (shopifyOptionAxes(axes).length > 3) {
    warnings.push(`Shopify takes at most 3 options per product and this set has ${axes.length}.`)
  }
  for (const option of productOptions) {
    const values = option.values.map((v) => v.name).filter(Boolean)
    if (values.length === 0) {
      warnings.push(`${option.name} would arrive with no values — Shopify refuses an option no variant uses.`)
    }
  }

  return {
    kind: 'shopify-in-place',
    coordinate: coordinateOf(read),
    title,
    subline: `${read.parent.sku} · ${included.length} ${included.length === 1 ? 'variant' : 'variants'} · ${before.join(' · ') || '—'} → ${after.join(' · ') || '—'}`,
    from: before.join(' · ') || '—',
    to: after.join(' · ') || '—',
    banner: PLAN_COPY.shopifyBanner,
    steps,
    keeps: ['the product and its handle', 'variant ids for every option combination Shopify can keep', 'inventory, prices and media'],
    loses: removed.length
      ? [`the ${removed.join(', ')} option and the variant ids that only it told apart`]
      : ['nothing this plan can name — no option is removed'],
    warnings,
    dryRun: true,
    meta: {
      tookMs: Date.now() - t0,
      adapter: 'shopify/content-publisher#buildShopifyProductOptions',
      providerCalls: 0,
    },
  }
}

function coordinateOf(read: ProjectionRead): ThemeChangePlan['coordinate'] {
  return {
    channel: read.coordinate.channel,
    market: read.coordinate.market,
    accountId: read.coordinate.accountId,
    aliasKey: read.coordinate.aliasKey,
    label: read.coordinate.label,
  }
}

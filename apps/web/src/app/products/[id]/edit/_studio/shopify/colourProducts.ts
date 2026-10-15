/**
 * Colour products in the Product family tab — the pure half: what the API returns
 * (`/api/products/:id/shopify-colour-products`), and what each colour row, the Confirm review and the Start full sync
 * review say. No fetch, no React: `colourProducts.vitest.test.ts` covers it.
 */
import { compareGarmentSizes } from '@nexus/shared/garment-size-order'

export type ColourState = 'NOT_FOUND' | 'PROPOSED' | 'LINKED' | 'DELETED'
/** A size as Nexus names it; `shopify`: the values the size map pairs it with on this store, when they differ. */
export interface ColourSize { productId: string; sku: string; options: string[]; shopify?: string[] }
export interface ColourPlanProduct {
  key: string; position: number; nexusValue: string; colourName: string; variants: number; sizes?: ColourSize[]; options?: Array<{ axis: string; name: string; values: string[] }>
  /** Its swatch group on the store (an index; null: in no group of a family the store splits into several). */
  swatchGroup?: number | null
}
export interface ColourMatchVariant { productId: string; sku: string; shopifyVariantId: string; inventoryItemId: string | null; shopifySku: string | null; by: 'sku' | 'options' }
export interface ColourProposal {
  method: 'linked' | 'operator' | 'sku' | 'name' | 'group' | null
  shopifyProductId: string | null; title: string | null; handle: string | null; status: string | null; shopifyColourName: string | null
  variants: ColourMatchVariant[]
  missing: Array<{ productId: string; sku: string; options: string[] }>
  extra: Array<{ shopifyVariantId: string; sku: string | null; options: string[] }>
  /** The Nexus SKUs Confirm writes: where the variant has none, or (`from`) has the same SKU in another letter case. */
  skusToWrite: Array<{ shopifyVariantId: string; sku: string; from?: string }>
  skusToReplace?: Array<{ productId: string; shopifyVariantId: string; from: string; to: string }>
  chosenProductId?: string | null
  /** The product's colour list (`custom.variation_products`) as Find read it. */
  swatchGroup?: string[] | null
  issues: Array<{ code?: string; message: string }>
}
export interface ColourProductRow { id: string; valueKey: string; colourName: string | null; state: ColourState; shopifyProductId: string | null; remoteStatus: string | null; proposal: ColourProposal | null; swatchGroup?: string[] | null }
/** The size map: native axis code → { Nexus value → Shopify option value }. */
export type SizeMap = Record<string, Record<string, string>>
export interface ColourSettings { enabled: boolean; method: 'theme-metafields'; valueField: { namespace: string; key: string }; listField: { namespace: string; key: string }; revision: string }
export interface ColourView {
  familyId: string; accountId: string; settings: ColourSettings
  sync?: { linked: boolean; adoptOnly: boolean }
  plan: { mode: 'colour-products' | 'one-product'; splitAxis: string | null; issues: Array<{ severity: 'error' | 'warning'; message: string; key?: string }>; products: ColourPlanProduct[]
    /** The axes whose value order the family sets (a dictionary attribute's); the others come A–Z by SKU. */
    orderedAxes?: string[]
    /** How many swatch groups the store shows this family's colours in. */
    swatchGroups?: number }
  sizeMap?: SizeMap
  colourProducts: ColourProductRow[]
  locations?: Array<{ id: string; name: string }>
}
export interface StoreProduct {
  id: string; title: string; handle: string; status: string; image: string | null; colourName: string | null; variants: number | null; sampleSku: string | null
  linkedTo: { familySku: string; valueKey: string; state: string; thisFamily: boolean } | null
}

/** One size of a colour and the Shopify variant it pairs with (null: not on that product). `shopifySize`: its size on Shopify through the size map. */
export interface SizePair { productId: string; size: string; shopifySize?: string; sku: string; shopify: { sku: string | null; by: 'sku' | 'options' } | null }

export interface ColourRowModel {
  key: string; name: string; row: ColourProductRow | null; proposal: ColourProposal | null
  status: 'linked' | 'proposed' | 'none' | 'deleted'
  /** The product shown for the colour: the linked one, else Find's proposal. */
  product: { id: string; title: string; status: string | null; showsColour: string | null; how: string } | null
  pairs: SizePair[]; matched: number
  /** Shopify sizes the product has and no Nexus size pairs with. */
  shopifyOnly: string[]
  /** "No size of … matches": the Nexus and the Shopify size names side by side, for a product none of whose sizes pair. */
  noSizeMatch: string | null
  chosenByOperator: boolean
  /** Sizes are left on both sides (or a size map exists): the operator may pair them ("Pair sizes…"). */
  canPairSizes: boolean
}

const sizeName = (options: readonly string[]) => options.join(' / ') || 'One size'

/**
 * A colour's sizes in the order the panel lists them: an axis the family orders keeps the plan's order; a free-text axis
 * (first use, A–Z by SKU: 3XL, 4XL, L, M …) goes in garment size order (XXS … 5XL, 44 … 60, then the rest).
 */
export function sizesInOrder(product: ColourPlanProduct, orderedAxes: readonly string[] = []): ColourSize[] {
  const sizes = product.sizes ?? [], options = product.options ?? []
  if (!options.some(o => !orderedAxes.includes(o.axis))) return sizes
  return [...sizes].sort((a, b) => {
    for (let i = 0; i < options.length; i++) {
      const x = a.options[i] ?? '', y = b.options[i] ?? ''
      const d = orderedAxes.includes(options[i].axis) ? options[i].values.indexOf(x) - options[i].values.indexOf(y) : compareGarmentSizes(x, y)
      if (d) return d
    }
    return 0
  })
}
const HOW: Record<string, string> = { linked: 'Linked', operator: 'Chosen by you', sku: 'Found by its SKUs', name: 'Found by its colour name', group: 'Found through its colour group' }
const short = (id: string | null | undefined) => (id ?? '').split('/').pop() ?? ''

export function colourRows(view: ColourView): ColourRowModel[] {
  return view.plan.products.map(product => {
    const row = view.colourProducts.find(r => r.valueKey === product.key) ?? null
    const proposal = row?.proposal ?? null
    const status = row?.state === 'LINKED' ? 'linked' : row?.state === 'DELETED' ? 'deleted' : row?.state === 'PROPOSED' && proposal?.shopifyProductId ? 'proposed' : 'none'
    const shownId = status === 'linked' ? row!.shopifyProductId : proposal?.shopifyProductId ?? null
    const sameAsProposal = !!shownId && proposal?.shopifyProductId === shownId
    const sizes = sizesInOrder(product, view.plan.orderedAxes)
    const pairs: SizePair[] = sizes.map(size => {
      const hit = sameAsProposal ? proposal!.variants.find(v => v.productId === size.productId) : undefined
      return { productId: size.productId, size: sizeName(size.options), ...(size.shopify ? { shopifySize: sizeName(size.shopify) } : {}), sku: hit?.sku ?? size.sku, shopify: hit ? { sku: hit.shopifySku, by: hit.by } : null }
    })
    const matched = pairs.filter(p => p.shopify).length
    const shopifyOnly = sameAsProposal ? proposal!.extra.map(e => sizeName(e.options)) : []
    const noSizeMatch = sameAsProposal && sizes.length > 0 && matched === 0
      ? `No size of "${product.nexusValue}" matches a size of "${proposal!.title ?? 'the Shopify product'}". Nexus sizes: ${sizes.map(s => sizeName(s.options)).join(', ')}. Shopify sizes: ${shopifyOnly.join(', ') || 'none'}.`
      : null
    return {
      key: product.key, name: product.nexusValue, row, proposal, status,
      product: shownId ? { id: shownId, title: (sameAsProposal ? proposal!.title : null) ?? `Shopify product ${short(shownId)}`, status: (sameAsProposal ? proposal!.status : null) ?? row?.remoteStatus ?? null,
        showsColour: sameAsProposal ? proposal!.shopifyColourName : row?.colourName ?? null, how: status === 'linked' ? 'Linked' : HOW[proposal?.method ?? ''] ?? 'Proposed' } : null,
      pairs, matched, shopifyOnly, noSizeMatch, chosenByOperator: !!proposal?.chosenProductId && status !== 'linked',
      canPairSizes: sameAsProposal && (product.options?.length ?? 0) > 0 && (matched < pairs.length && shopifyOnly.length > 0 || Object.keys(view.sizeMap ?? {}).length > 0),
    }
  })
}

const fold = (text: string) => text.trim().toLocaleLowerCase('en')

/** The colour's name on Shopify before the operator types one: the name it has in Nexus, else the one its product shows today. */
export function defaultColourName(model: ColourRowModel): string {
  return model.row?.colourName ?? model.proposal?.shopifyColourName ?? model.name
}

/**
 * The name Confirm sends: the typed one, except the Nexus value left as it is on a colour that has no name yet (Confirm
 * then keeps none, and the colour follows its Nexus value).
 */
export function colourNameToSend(model: ColourRowModel, typed: string): string | undefined {
  const name = typed.trim()
  return !name || model.row?.colourName == null && model.proposal?.shopifyColourName == null && name === model.name ? undefined : name
}

/**
 * Why a typed colour name would be refused (as Confirm refuses it), or null. A name may repeat across swatch groups, and
 * inside one when it is the name the product shows on the store today; a repeat Nexus would create is not allowed.
 */
export function colourNameClash(view: ColourView, model: ColourRowModel, name: string): string | null {
  const typed = name.trim(), product = view.plan.products.find(p => p.key === model.key)
  if (!typed || !product || product.swatchGroup === null) return null
  if (typed === model.proposal?.shopifyColourName?.trim()) return null
  const group = product.swatchGroup ?? 0
  const others = view.plan.products.filter(p => p.key !== model.key && (p.swatchGroup ?? 0) === group && p.swatchGroup !== null && fold(p.colourName) === fold(typed))
  return others.length ? `"${model.name}" would be called "${typed}" on Shopify, like ${others.map(o => `"${o.nexusValue}"`).join(', ')} in the same swatch group. Give it its own name.` : null
}

/** The colour's swatch group in words, when the store shows the family in several (else null: one group, nothing to say). */
export function swatchGroupWords(view: ColourView, model: ColourRowModel): string | null {
  const count = view.plan.swatchGroups ?? 1, product = view.plan.products.find(p => p.key === model.key)
  if (count < 2 || !product) return null
  if (product.swatchGroup === null || product.swatchGroup === undefined) return `In no group on the store (the family has ${count})`
  const members = view.plan.products.filter(p => p.swatchGroup === product.swatchGroup).map(p => p.nexusValue)
  return `Group ${product.swatchGroup + 1} of ${count}: ${members.join(', ')}`
}

/** One native option of the family for the size map: each Nexus value, the Shopify value it is paired with, and the Shopify values to choose from. */
export interface SizeMapAxis { axis: string; name: string; values: Array<{ nexus: string; shopify: string | null }>; choices: string[] }

/**
 * The size map for one colour's review: every native option of the family with all its Nexus values (the map is the
 * family's on this store), the pairing saved, and as choices the values this colour's Shopify product has that no size
 * pairs with yet, plus those already in the map.
 */
export function sizeMapAxes(view: ColourView, model: ColourRowModel): SizeMapAxis[] {
  const product = view.plan.products.find(p => p.key === model.key)
  const extra = model.proposal?.shopifyProductId === model.product?.id ? model.proposal?.extra ?? [] : []
  return (product?.options ?? []).map(option => {
    const values = [...new Set(view.plan.products.flatMap(p => p.options?.find(o => o.axis === option.axis)?.values ?? []))]
    const saved = view.sizeMap?.[option.axis] ?? {}
    const choices = [...new Set([...extra.flatMap(e => e.options), ...Object.values(saved)])].filter(Boolean)
    return { axis: option.axis, name: option.name, values: values.map(nexus => ({ nexus, shopify: saved[nexus] ?? null })), choices }
  })
}

/** The size map to save from the operator's choices (a value paired with itself, or with nothing, is no pairing). */
export function sizeMapOf(axes: readonly SizeMapAxis[]): SizeMap {
  const out: SizeMap = {}
  for (const axis of axes) {
    const pairs = axis.values.filter(v => v.shopify && v.shopify !== v.nexus).map(v => [v.nexus, v.shopify!] as const)
    if (pairs.length) out[axis.axis] = Object.fromEntries(pairs)
  }
  return out
}

/** Why Confirm cannot run for this colour now (empty: it can). `replace`: the operator ticked "Replace these SKUs". */
export function confirmBlockers(model: ColourRowModel, replace: boolean): string[] {
  if (model.status === 'linked') return ['Already linked.']
  if (model.status !== 'proposed' || !model.proposal) return ['Choose its Shopify product first.']
  const out = model.proposal.issues.map(i => i.message)
  if (model.noSizeMatch) out.push(model.noSizeMatch)
  else if (!model.matched) out.push(`No size of "${model.name}" matches a size of "${model.product?.title ?? 'the Shopify product'}".`)
  if (model.proposal.skusToReplace?.length && !replace) out.push('Its Shopify sizes carry other SKUs: choose to replace them with the Nexus SKUs, or change them in Shopify.')
  return out
}

/** Exactly what Confirm writes for one colour, for the review. */
export function confirmWrites(model: ColourRowModel, replace: boolean) {
  const p = model.proposal!
  const sizeOf = (variantId: string) => model.pairs.find(pair => p.variants.find(v => v.shopifyVariantId === variantId)?.productId === pair.productId)?.size ?? 'One size'
  return {
    product: model.product?.title ?? '',
    identity: 'nexus.family_id — the Nexus identity of this colour (a hidden product field)',
    skus: p.skusToWrite.map(s => ({ size: sizeOf(s.shopifyVariantId), sku: s.sku, ...(s.from ? { from: s.from } : {}) })),
    replaced: replace ? (p.skusToReplace ?? []).map(r => ({ size: sizeOf(r.shopifyVariantId), from: r.from, to: r.to })) : [],
  }
}

/** The family's sync state in words. */
export function syncWords(view: ColourView): { label: string; tone: 'neutral' | 'info' | 'success'; text: string } {
  if (!view.sync?.linked) return { label: 'Not linked', tone: 'neutral', text: 'No colour of this family is linked to a Shopify product yet. Linking writes only the Nexus identity and the SKUs you review.' }
  if (view.sync.adoptOnly) return { label: 'Linked (adopt only)', tone: 'info', text: 'Nexus linked these colours and writes nothing else to them: no stock, no prices, no sizes, no size order, no archive and no colour swatches. Their size listings stay paused.' }
  return { label: 'Full sync', tone: 'success', text: 'Nexus sends stock, adds missing sizes, keeps the size order, archives colours the family no longer has and writes the colour swatch fields of this family.' }
}

/** What Start full sync turns on, for its review (the swatch warning first: it is the one the store sees at once). */
export function fullSyncEffects(view: ColourView): string[] {
  const field = (f: { namespace: string; key: string }) => `${f.namespace}.${f.key}`
  return [
    `Colour swatches: Nexus writes ${field(view.settings.valueField)} (the colour name) and ${field(view.settings.listField)} (the colour list) on every linked product of this family. Each product keeps the swatch group it has on the store today (for example men's and women's colours stay apart): each group gets one list of its own linked colours, in the order the store lists them today (a colour new to the group goes last; only colours the store does not group yet follow the Nexus colour order), and each product the colour name shown here (by default the one the store showed). A colour in no group joins the family's group when the store shows one; with several groups it waits until the store puts it in one.`,
    'Stock and prices: every linked size receives its Nexus stock, and its size listing follows the regular Nexus stock and price sync like any live Shopify listing.',
    'Sizes: a size Nexus has and the product lacks is created (at zero stock, at the listing\'s price); the sizes are put in the Nexus order.',
    'Archive: a colour this family no longer has is archived on Shopify.',
    'The size listings this link paused are resumed; a listing you paused yourself stays paused.',
  ]
}

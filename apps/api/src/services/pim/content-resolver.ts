import type { CellProvenance } from '@nexus/shared/cell-provenance'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE, contentHash } from './content-locale.js'
import { normalizeLanguage, type ContentLanguage } from './content-language.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export type { ContentLanguage } from './content-language.js'
export type { ContentAddress } from '@nexus/shared/content-language'
export type Coordinate = import('@nexus/shared/content-language').ContentCoordinate

export interface ResolvedContent {
  value: unknown
  tier: 'pin' | 'language' | 'source' | 'computed'
  language: ContentLanguage
  requested: ContentLanguage
  /** A following legacy snapshot is drift, not an operator-authored pin (Q-LX3-1). */
  follows?: boolean
  drift?: boolean
  ownerId?: string
  // LX.12 adds the renderer for this already-designed member in Step 6. No new UI vocabulary here.
  provenance: { member: CellProvenance; from: string | null }
  translation?: { source: 'manual' | 'ai' | 'translated'; reviewedAt: string | null; outdated: boolean }
}

type Bag = Record<string, unknown>
export interface ContentTranslation extends Bag {
  language: string
  workspaceId?: string | null
  productId?: string
  channelListingId?: string
  attributes?: Bag | null
  source?: 'manual' | 'ai' | 'translated' | null
  sourceHash?: string | null
  reviewedAt?: string | Date | null
  follows?: string[]
}
export interface ContentProduct extends Bag {
  id: string
  workspaceId?: string | null
  parentId?: string | null
  categoryAttributes?: Bag | null
  translations?: ContentTranslation[]
}
export interface ContentListing extends Bag {
  id: string
  productId: string
  workspaceId?: string | null
  coordinate: Coordinate
  /** Hydrated from marketLanguages(channel, code), never inferred from a country map. */
  languages: readonly string[]
  translations?: ContentTranslation[]
}
export interface ResolveContentInput {
  product: ContentProduct
  parent?: ContentProduct | null
  listing?: ContentListing | null
  field: string
  address: { requested: ContentLanguage; coordinate?: Coordinate }
  /** Family-declared localizable attributes, in addition to the four native content fields. */
  localizableKeys?: readonly string[]
  computed?: { value: unknown; language: ContentLanguage; provenance: ResolvedContent['provenance'] }
}

/** Q-LX3-1 accepted: v2 is the application default. No Railway environment/deployment mutation. */
export const contentResolverEnabled = () => (process.env.NEXUS_CONTENT_RESOLVER ?? 'v2') === 'v2'
export const isOperatorContentPin = (content: Pick<ResolvedContent, 'tier' | 'follows'>) => content.tier === 'pin' && content.follows === false
/** Content can be non-empty source fallback and still be missing in the requested language. */
export const translationMissing = (content: { language?: string }, requested: string) => content.language !== normalizeLanguage(requested)
export const contentField = (field: string) => field === 'name' ? 'title' : field
export const isLocalizableContent = (field: string, storage?: string) => storage === 'localizedContent' || Object.prototype.hasOwnProperty.call(CONTENT_COLUMNS, contentField(field))
const present = (value: unknown) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
const workspace = (row: { workspaceId?: string | null }) => row.workspaceId ?? null
const label = (language: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language
const primary = () => normalizeLanguage(PRIMARY_CONTENT_LOCALE)

function sourceValue(product: ContentProduct, parent: ContentProduct | null | undefined, field: string): { value: unknown; owner: ContentProduct } | null {
  const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
  for (const owner of [product, parent]) {
    if (!owner) continue
    // Family attributes have authored presence (unlike nullable/default native columns).
    // An explicit null/empty on the child must not resurrect a parent's value.
    if (!column && Object.prototype.hasOwnProperty.call(owner.categoryAttributes ?? {}, field) && owner.categoryAttributes?.[field] !== undefined) return { value: owner.categoryAttributes[field], owner }
    let value = column ? owner[column] : owner.categoryAttributes?.[field]
    if (!column && !present(value)) {
      const variations = owner.categoryAttributes?.variations
      const bag = { ...(owner.variantAttributes as Bag ?? {}), ...(variations && typeof variations === 'object' && !Array.isArray(variations) ? variations : {}) }
      value = bag[field]
      if (value === undefined && ['color', 'size', 'style'].includes(field)) {
        const aliases = Object.entries(bag).filter(([key, value]) => canonicalVariantAxis(key) === field && value !== undefined)
        if (new Set(aliases.map(([, value]) => JSON.stringify(value))).size > 1) throw new Error(`Conflicting source variant attributes for ${field}`)
        value = aliases[0]?.[1]
      }
      if (value !== undefined) return { value, owner }
    }
    if (present(value)) return { value, owner }
  }
  return null
}

/** One row-level source fingerprint, shared with Step 4 authoring. No legacy JSON contributes. */
export function contentSourceHash(product: ContentProduct, parent?: ContentProduct | null, localizableKeys: readonly string[] = []): string {
  const fields = [...new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)])].sort()
  return contentHash(Object.fromEntries(fields.map(field => [field, sourceValue(product, parent, field)?.value ?? null])))
}

/** Normalize stored tags in memory only. Prefer a canonical key; reject ambiguous regional siblings. */
function translationIndex(rows: ContentTranslation[] = []): Map<string, ContentTranslation> {
  const index = new Map<string, ContentTranslation>()
  const groups = new Map<string, ContentTranslation[]>()
  for (const row of rows) {
    const language = normalizeLanguage(row.language)
    groups.set(language, [...(groups.get(language) ?? []), row])
  }
  for (const [language, group] of groups) {
    const canonical = group.filter(row => row.language === language)
    const candidates = canonical.length ? canonical : group
    if (candidates.length !== 1) throw new Error(`Ambiguous content translations for ${language}`)
    index.set(language, candidates[0])
  }
  return index
}

export function coordinateMatches(a: Coordinate, b: Coordinate): boolean {
  return a.channel === b.channel && a.market === b.market && (a.accountId ?? null) === (b.accountId ?? null) && (a.aliasId ?? null) === (b.aliasId ?? null)
}

function translationValue(row: ContentTranslation | undefined, field: string): unknown {
  if (!row) return undefined
  // Native clears use authored presence in the existing attributes bag. Nullable
  // default columns alone cannot distinguish a clear from an untouched field.
  if (Object.prototype.hasOwnProperty.call(row.attributes ?? {}, field)) return row.attributes![field]
  const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
  return column ? row[column] : row.attributes?.[field]
}

const LEGACY_CONTENT_FIELDS = {
  title: ['titleOverride', 'title', 'followMasterTitle'],
  description: ['descriptionOverride', 'description', 'followMasterDescription'],
  bulletPoints: ['bulletPointsOverride', null, 'followMasterBulletPoints'],
} as const
export function legacyPin(listing: ContentListing, field: string): unknown {
  const spec = LEGACY_CONTENT_FIELDS[field as keyof typeof LEGACY_CONTENT_FIELDS]
  if (!spec) return undefined
  // Follow-master flags govern explicit overrides; the untagged stored columns remain legacy pins (LX.3).
  if (listing[spec[2]] !== true && present(listing[spec[0]])) return listing[spec[0]]
  return spec[1] ? listing[spec[1]] : undefined
}

/** Following intent used by the write cascade and the acknowledgement's reach. */
export function listingFollowsContent(listing: Record<string, any>, fieldInput: string, requested: string, languages: readonly string[]): boolean {
  const field = contentField(fieldInput), language = normalizeLanguage(requested)
  const row = (listing.translations ?? []).find((row: ContentTranslation) => normalizeLanguage(row.language) === language) as ContentTranslation | undefined
  if (row?.follows?.includes(field)) return true
  if (present(translationValue(row, field)) || Object.prototype.hasOwnProperty.call(row?.attributes ?? {}, field)) return false
  const flag = LEGACY_CONTENT_FIELDS[field as keyof typeof LEGACY_CONTENT_FIELDS]?.[2]
  return language !== normalizeLanguage(languages[0]) || !flag || listing[flag] !== false || !present(legacyPin(listing as ContentListing, field))
}

function resolver(input: Omit<ResolveContentInput, 'field' | 'address' | 'computed'>) {
  if (!contentResolverEnabled()) throw new Error('Content resolver v2 is disabled.')
  const { product, parent, listing, localizableKeys = [] } = input
  if (parent && (product.parentId !== parent.id || workspace(parent) !== workspace(product))) throw new Error('Content parent does not belong to this product/workspace.')
  if (listing && (listing.productId !== product.id || workspace(listing) !== workspace(product))) throw new Error('Content listing does not belong to this product/workspace.')
  const owners = [product, parent].filter((owner): owner is ContentProduct => !!owner)
  const translations = owners.map(owner => translationIndex((owner.translations ?? []).filter(row => workspace(row) === workspace(owner) && (!row.productId || row.productId === owner.id))))
  const pins = translationIndex((listing?.translations ?? []).filter(row => workspace(row) === workspace(product) && (!row.channelListingId || row.channelListingId === listing?.id)))
  const sourceLanguage = primary()
  const hashes = new Map<string, string>()
  const allowed = new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)])

  return (fieldInput: string, address: ResolveContentInput['address'], computed?: ResolveContentInput['computed']): ResolvedContent => {
    const field = contentField(fieldInput), requested = normalizeLanguage(address.requested)
    if (!allowed.has(field)) throw new Error(`Field ${field} is not declared localizable.`)
    const result = (value: unknown, tier: ResolvedContent['tier'], language: string, member: ResolvedContent['provenance']['member'], from: string | null): ResolvedContent => ({ value, tier, language, requested, provenance: { member, from } })
    const translated = (row: ContentTranslation, value: unknown, tier: 'pin' | 'language', owner: ContentProduct): ResolvedContent => {
      const source = String(row.source ?? 'manual').startsWith('ai') ? 'ai' : row.source ?? 'manual'
      const reviewedAt = row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null
      const authoredFields = Object.keys(row.attributes ?? {}).sort()
      const hashKey = JSON.stringify([owner.id, authoredFields])
      if (row.sourceHash && !hashes.has(hashKey)) hashes.set(hashKey, contentSourceHash(owner, owner === product ? parent : null, authoredFields))
      const outdated = !!row.sourceHash && row.sourceHash !== hashes.get(hashKey)
      const machine = source === 'ai' || source === 'translated'
      const member = outdated ? machine && !reviewedAt ? 'aiStale' : 'outdated' : machine && !reviewedAt ? 'ai' : tier === 'pin' ? 'pinned' : address.coordinate || owner !== product ? 'inherited' : 'own'
      return { ...result(value, tier, requested, member, tier === 'pin' ? listing!.id : `${label(requested)} · shared`), ownerId: owner.id, translation: { source, reviewedAt, outdated } }
    }
    if (address.coordinate && listing) {
      if (!coordinateMatches(listing.coordinate, address.coordinate)) throw new Error('Content listing coordinate does not match the requested address.')
      if (!listing.languages.length) throw new Error('Content listing needs its market languages.')
      const pin = pins.get(requested), value = translationValue(pin, field)
      if (!pin?.follows?.includes(field) && (present(value) || Object.prototype.hasOwnProperty.call(pin?.attributes ?? {}, field))) return { ...translated(pin!, value, 'pin', product), follows: false }
      if (!pin?.follows?.includes(field) && requested === normalizeLanguage(listing.languages[0])) {
        const legacy = legacyPin(listing, field)
        if (present(legacy)) {
          const flag = LEGACY_CONTENT_FIELDS[field as keyof typeof LEGACY_CONTENT_FIELDS]?.[2]
          const follows = flag ? listing[flag] !== false : false
          return { ...result(legacy, 'pin', requested, follows ? 'inherited' : 'pinned', listing.id), follows, drift: follows, ownerId: product.id }
        }
      }
    }
    if (requested !== sourceLanguage) for (const [i, owner] of owners.entries()) {
      const row = translations[i].get(requested), value = translationValue(row, field)
      if (present(value) || Object.prototype.hasOwnProperty.call(row?.attributes ?? {}, field)) return translated(row!, value, 'language', owner)
    }
    const source = sourceValue(product, parent, field)
    if (source) return { ...result(source.value, 'source', sourceLanguage, address.coordinate || requested !== sourceLanguage || source.owner !== product ? 'inherited' : 'own', `${label(sourceLanguage)} · source`), ownerId: source.owner.id }
    if (computed && present(computed.value)) return { ...result(computed.value, 'computed', normalizeLanguage(computed.language), computed.provenance.member, computed.provenance.from) }
    return result(null, 'computed', sourceLanguage, 'inherited', null)
  }
}

/** Pure: consumes hydrated rows only. Never reads localizedContent, overrideData or outbound platformAttributes. */
export function resolveContent(input: ResolveContentInput): ResolvedContent {
  return resolver(input)(input.field, input.address, input.computed)
}

/** Mapping source paths keep their explicit language/link semantics, but never walk legacy JSON. */
export function contentPathAddress(path: string, requested: string, localizableKeys: readonly string[] = []): { field: string; requested: string; tail: string[] } | null {
  const parts = path.replace(/\{locale\}/g, requested).split('.')
  let language = requested
  if (parts[0] === 'localizedContent') { parts.shift(); language = parts.shift() ?? '' }
  else if (['categoryAttributes', 'variantAttributes'].includes(parts[0])) parts.shift()
  const field = contentField(parts.shift() ?? '')
  if (![...Object.keys(CONTENT_COLUMNS), ...localizableKeys].includes(field)) return null
  return { field, requested: normalizeLanguage(language), tail: parts }
}

export function resolveContentPath(input: Omit<ResolveContentInput, 'field'> & { path: string }): ResolvedContent | null {
  const path = contentPathAddress(input.path, input.address.requested, input.localizableKeys)
  if (!path) return null
  const resolved = resolveContent({ ...input, field: path.field, address: { ...input.address, requested: path.requested } })
  let value = resolved.value
  for (const key of path.tail) value = value && typeof value === 'object' ? (value as Bag)[key] ?? null : null
  return { ...resolved, value }
}

/** One translation index per family member; all fields × addresses reuse it. No database queries. */
export function resolveContentBatch(input: {
  members: Array<Omit<ResolveContentInput, 'field' | 'address' | 'computed'>>
  fields: readonly string[]
  addresses: ReadonlyArray<ResolveContentInput['address']>
}): Array<{ productId: string; address: ResolveContentInput['address']; fields: Record<string, ResolvedContent> }> {
  return input.members.flatMap(member => {
    const resolve = resolver(member)
    return input.addresses.map(address => ({ productId: member.product.id, address: { ...address, requested: normalizeLanguage(address.requested) }, fields: Object.fromEntries(input.fields.map(field => [field, resolve(field, address)])) }))
  })
}

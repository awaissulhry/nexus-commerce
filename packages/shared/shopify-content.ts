import { z } from 'zod'
import { mediaCaptionSchema } from './product-media.js'

const id = z.string().min(1).max(160)
const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
export const shopifyFieldTypes = ['single_line_text_field', 'multi_line_text_field', 'rich_text_field', 'boolean', 'number_integer', 'number_decimal', 'color', 'url', 'json', 'file_reference', 'list.file_reference', 'metaobject_reference', 'list.metaobject_reference'] as const
export const contentValueSchema = z.object({ value: z.string().max(60000).nullable(), translations: z.record(locale, z.string().max(60000)).default({}) }).strict()
const fieldSchema = z.object({ namespace: z.string().regex(/^[a-zA-Z0-9_-]{3,255}$/), key: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/), label: z.string().min(1).max(255), type: z.enum(shopifyFieldTypes), metaobjectType: z.string().max(255).optional(), storefront: z.boolean().optional() }).strict()
export const shopifyContentSchema = z.object({
  target: z.enum(['new-draft', 'linked-product']).optional(),
  collectionMode: z.enum(['groups', 'variants', 'family']).optional(), collectionAxes: z.array(z.string()).max(3).optional(),
  version: z.literal(1), defaultLocale: locale, locales: z.array(locale).min(1).max(20), axes: z.array(z.string().min(1).max(255)).max(3),
  assets: z.array(z.object({ id, url: z.url().refine(v => v.startsWith('https://'), 'Media require HTTPS'), type: z.enum(['IMAGE', 'VIDEO', 'MODEL_3D']).optional(), alt: z.string().max(512), translations: z.record(locale, z.string().max(512)).default({}), accessibility: z.record(locale, z.object({ captions: z.array(mediaCaptionSchema).max(30).optional(), transcript: z.string().max(50000).optional() }).strict()).optional() }).strict()).max(250),
  groups: z.array(z.object({ id, name: z.string().min(1).max(160), assetIds: z.array(id).max(250), featuredId: id.nullable() }).strict()).max(250),
  fields: z.array(fieldSchema).max(80),
  assignments: z.array(z.object({
    id, name: z.string().min(1).max(160),
    target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('family') }).strict(), z.object({ kind: z.literal('options'), values: z.record(z.string(), z.string()) }).strict(), z.object({ kind: z.literal('variant'), variantId: id }).strict()]),
    priority: z.number().int().min(-100).max(100).default(0),
    gallery: z.object({ mode: z.enum(['replace', 'append']), groupIds: z.array(id).max(250), featuredId: id.nullable(), preserveOrder: z.boolean().optional() }).strict().optional(),
    values: z.record(z.string(), contentValueSchema),
  }).strict()).max(1000),
  metaobjectDefinitions: z.array(z.object({ type: z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/), name: z.string().min(1).max(255), fields: z.array(fieldSchema.omit({ namespace: true })).min(1).max(40) }).strict()).max(40),
  metaobjects: z.array(z.object({ id, type: z.string().min(1), handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}$/), fields: z.record(z.string(), contentValueSchema) }).strict()).max(250),
}).strict()

export type ShopifyContent = z.infer<typeof shopifyContentSchema>
export type ContentValue = z.infer<typeof contentValueSchema>
export type ContentField = ShopifyContent['fields'][number]
export type ContentAssignment = ShopifyContent['assignments'][number]
export interface ContentVariant { id: string; sku: string; options: Record<string, string>; price: string; stock: number; compareAtPrice?: string | null; shopifyVariantId?: string | null }
export const fieldKey = (f: Pick<ContentField, 'namespace' | 'key'>) => `${f.namespace}.${f.key}`
export const emptyShopifyContent = (axes: string[] = []): ShopifyContent => ({ target: 'new-draft', version: 1, defaultLocale: 'it', locales: ['it', 'en'], axes, assets: [], groups: [], fields: [], assignments: [{ id: 'family', name: 'Family defaults', target: { kind: 'family' }, priority: 0, values: {} }], metaobjectDefinitions: [], metaobjects: [] })
export const localizedValue = (value: ContentValue, language: string, defaultLocale: string): string | null => language === defaultLocale ? value.value : value.translations[language] ?? value.translations[language.split('-')[0]] ?? value.value
export function collectionCards(content: ShopifyContent, variants: ContentVariant[]) {
  const mode = content.collectionMode ?? 'groups'
  const axes = content.collectionAxes ?? [content.axes.find(a => /^(colou?r|colore)$/i.test(a)) ?? content.axes[0]].filter((a): a is string => !!a)
  const groups = new Map<string, { id: string; label: string; variantIds: string[]; optionIndexes: number[] }>()
  for (const variant of variants) {
    const values = mode === 'family' ? [] : mode === 'variants' ? content.axes.map(axis => variant.options[axis]) : axes.map(axis => variant.options[axis])
    const id = mode === 'variants' ? `variant:${variant.id}` : mode === 'family' ? 'family' : `options:${encodeURIComponent(JSON.stringify(axes.map(axis => [axis, variant.options[axis]])))}`
    const group = groups.get(id) ?? { id, label: values.join(' / ') || 'Family', variantIds: [], optionIndexes: (mode === 'family' ? [] : mode === 'variants' ? content.axes : axes).map(axis => content.axes.indexOf(axis)) }
    group.variantIds.push(variant.id); groups.set(id, group)
  }
  return [...groups.values()]
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const unique = <T>(values: T[]) => [...new Set(values)]
const score = (a: ContentAssignment) => (a.target.kind === 'variant' ? 4 : a.target.kind === 'options' ? Object.keys(a.target.values).length : 0) * 1000 + a.priority
const matches = (a: ContentAssignment, variant: ContentVariant | null) => a.target.kind === 'family' || (variant !== null && (a.target.kind === 'variant' ? a.target.variantId === variant.id : Object.entries(a.target.values).every(([axis, value]) => variant.options[axis] === value)))

/** One resolver shared by preview and publishing. IDs and canonical option values never use translations or alt text. */
export function resolveShopifyContent(content: ShopifyContent, variant: ContentVariant | null, language = content.defaultLocale) {
  const candidates = content.assignments.filter(a => matches(a, variant)).sort((a, b) => score(a) - score(b))
  const conflicts: string[] = []
  const sources: Record<string, string[]> = {}
  const values: Record<string, ContentValue> = {}
  const fields: Record<string, string | null> = {}
  for (const definition of content.fields) {
    const key = fieldKey(definition)
    const set = candidates.filter(a => Object.hasOwn(a.values, key))
    const top = set.filter(a => score(a) === score(set.at(-1)!))
    if (!top.length) continue
    if (top.some(a => !equal(a.values[key], top[0].values[key]))) { conflicts.push(`Conflicting ${key}: ${top.map(a => a.name).join(', ')}`); continue }
    values[key] = top[0].values[key]
    fields[key] = localizedValue(values[key], language, content.defaultLocale)
    sources[key] = top.map(a => a.id)
  }
  // A replace discards all less-specific galleries (including their ambiguity).
  const galleries = candidates.filter(a => a.gallery)
  const lastReplace = galleries.filter(a => a.gallery!.mode === 'replace').at(-1)
  const applicable = lastReplace ? galleries.filter(a => score(a) >= score(lastReplace)) : galleries
  let assetIds: string[] = [], featuredId: string | null = null, preserveOrder = false
  for (const rank of unique(applicable.map(score))) {
    const peers = applicable.filter(a => score(a) === rank)
    if (peers.some(a => !equal(a.gallery, peers[0].gallery))) { conflicts.push(`Conflicting galleries: ${peers.map(a => a.name).join(', ')}`); continue }
    const a = peers[0], gallery = a.gallery!
    preserveOrder = gallery.preserveOrder ?? false
    const groups = gallery.groupIds.map(id => content.groups.find(g => g.id === id)).filter(g => g !== undefined)
    const added = groups.flatMap(g => g.assetIds)
    assetIds = unique(gallery.mode === 'replace' ? added : [...assetIds, ...added])
    featuredId = gallery.featuredId ?? groups.find(g => g.featuredId)?.featuredId ?? (gallery.mode === 'replace' ? assetIds.find(id => (content.assets.find(a => a.id === id)?.type ?? 'IMAGE') === 'IMAGE') ?? null : featuredId)
    sources.gallery = gallery.mode === 'replace' ? peers.map(a => a.id) : [...(sources.gallery ?? []), ...peers.map(a => a.id)]
  }
  if (featuredId && !assetIds.includes(featuredId)) conflicts.push('The featured image must belong to the resolved gallery.')
  if (assetIds.length > 50) conflicts.push('Use at most 50 images in each resolved storefront gallery; the reusable library can contain 250 images.')
  if (!featuredId) featuredId = assetIds.find(id => (content.assets.find(a => a.id === id)?.type ?? 'IMAGE') === 'IMAGE') ?? null
  // Featured is the first slide everywhere: product cards, cart image, gallery and preview.
  if (!preserveOrder && featuredId && assetIds.includes(featuredId)) assetIds = [featuredId, ...assetIds.filter(id => id !== featuredId)]
  return { assetIds, featuredId, values, fields, sources, conflicts }
}

export function validateContentValue(field: Pick<ContentField, 'type' | 'metaobjectType'>, raw: string | null): string | null {
  if (raw === null) return null
  if (field.type === 'boolean' && !['true', 'false'].includes(raw)) return 'Use true or false.'
  if (field.type === 'number_integer' && !/^-?\d+$/.test(raw)) return 'Enter a whole number.'
  if (field.type === 'number_decimal' && !/^-?\d+(\.\d+)?$/.test(raw)) return 'Enter a decimal number.'
  if (field.type === 'color' && !/^#[0-9a-f]{6}$/i.test(raw)) return 'Enter a six-digit hex colour.'
  if (field.type === 'single_line_text_field' && (!raw.length || /[\r\n]/.test(raw))) return 'Enter one nonempty line, or clear the field explicitly.'
  if (field.type === 'multi_line_text_field' && !raw.length) return 'Enter text, or clear the field explicitly.'
  if (field.type === 'url') { try { if (!['https:', 'http:'].includes(new URL(raw).protocol)) return 'Enter an HTTP or HTTPS URL.' } catch { return 'Enter a valid URL.' } }
  if (['json', 'rich_text_field', 'list.file_reference', 'list.metaobject_reference'].includes(field.type)) {
    try {
      const value = JSON.parse(raw)
      if (field.type === 'rich_text_field' && (value?.type !== 'root' || !Array.isArray(value.children))) return 'Use Shopify rich text JSON with a root and children.'
      if (field.type.startsWith('list.') && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !validReference(field.type, v)))) return 'Enter a JSON array of valid references.'
      if (field.type.startsWith('list.') && Array.isArray(value) && value.length > 50) return 'Use at most 50 references in each storefront list.'
    } catch { return 'Enter valid JSON.' }
  }
  if (['metaobject_reference', 'file_reference'].includes(field.type) && !validReference(field.type, raw)) return 'Select a reusable entry or enter a Shopify reference ID.'
  return null
}
function validReference(type: string, v: string) { return type.includes('metaobject') ? /^(@metaobject:[A-Za-z0-9_-]+|gid:\/\/shopify\/Metaobject\/\d+)$/.test(v) : /^(@image:[A-Za-z0-9_-]+|gid:\/\/shopify\/(MediaImage|GenericFile|Video)\/\d+)$/.test(v) }

export function inspectShopifyContent(content: ShopifyContent, variants: ContentVariant[]) {
  const errors: string[] = []
  const duplicate = (values: string[], label: string) => { if (unique(values).length !== values.length) errors.push(`Duplicate ${label}.`) }
  duplicate(content.assets.map(a => a.id), 'image IDs'); duplicate(content.assets.map(a => a.url), 'image URLs; reuse the existing image'); duplicate(content.groups.map(g => g.id), 'group IDs')
  duplicate(content.assignments.map(a => a.id), 'assignment IDs'); duplicate(content.fields.map(fieldKey), 'metafield keys'); duplicate(content.axes, 'option axes'); duplicate(content.locales, 'locales')
  duplicate(content.metaobjectDefinitions.map(d => d.type), 'metaobject types'); duplicate(content.metaobjects.map(m => m.id), 'metaobject IDs'); duplicate(content.metaobjects.map(m => `${m.type}/${m.handle}`), 'metaobject handles')
  if (content.collectionAxes?.some(axis => !content.axes.includes(axis))) errors.push('Collection card axes must belong to the native family options.')
  if (content.fields.filter(f => f.storefront).length > 50) errors.push('Show at most 50 generic fields in product details.')
  if (!content.locales.includes(content.defaultLocale)) errors.push('Include the default language in the language list.')
  if (!variants.length || variants.length > 250) errors.push('Publish between 1 and 250 native variants per family.')
  duplicate(variants.map(v => v.sku), 'variant SKUs')
  duplicate(variants.map(v => v.id), 'variant IDs')
  duplicate(variants.map(v => JSON.stringify(content.axes.map(axis => v.options[axis]))), 'option combinations')
  for (const v of variants) {
    if (!v.sku || !/^\d+(\.\d{1,2})?$/.test(v.price) || !Number.isSafeInteger(v.stock) || v.stock < 0) errors.push(`${v.sku || v.id}: valid SKU, price and stock are required.`)
    if (v.compareAtPrice != null && (!/^\d+(\.\d{1,2})?$/.test(v.compareAtPrice) || Number(v.compareAtPrice) < Number(v.price))) errors.push(`${v.sku}: compare-at price must be at least the selling price.`)
    for (const axis of content.axes) if (!v.options[axis]) errors.push(`${v.sku}: missing ${axis}.`)
  }
  const assets = new Set(content.assets.map(a => a.id)), groups = new Set(content.groups.map(g => g.id)), definitions = new Map(content.fields.map(f => [fieldKey(f), f]))
  for (const g of content.groups) {
    duplicate(g.assetIds, `images in ${g.name}`)
    if (g.assetIds.some(id => !assets.has(id))) errors.push(`${g.name}: an image is missing.`)
    if (g.featuredId && !g.assetIds.includes(g.featuredId)) errors.push(`${g.name}: featured image must belong to the group.`)
  }
  const checkValue = (label: string, field: Pick<ContentField, 'type' | 'metaobjectType'>, value: ContentValue) => {
    if (Object.keys(value.translations).length && !['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(field.type)) errors.push(`${label}: translate the reusable entry’s text fields, not structural values or references.`)
    for (const language of Object.keys(value.translations)) if (!content.locales.includes(language)) errors.push(`${label}: add language ${language} to this document before publishing its translation.`)
    for (const raw of [value.value, ...Object.values(value.translations)]) {
      const error = validateContentValue(field, raw); if (error) errors.push(`${label}: ${error}`)
      if (raw && field.type.includes('metaobject_reference')) {
        let refs: string[] = []; try { refs = field.type.startsWith('list.') ? JSON.parse(raw) : [raw] } catch { continue }
        for (const ref of refs) if (typeof ref === 'string' && ref.startsWith('@metaobject:')) {
          const entry = content.metaobjects.find(m => m.id === ref.slice(12))
          if (!entry || entry.type !== field.metaobjectType) errors.push(`${label}: reusable entry is missing or has the wrong type.`)
        }
      }
      if (raw && field.type.includes('file_reference')) {
        let refs: string[] = []; try { refs = field.type.startsWith('list.') ? JSON.parse(raw) : [raw] } catch { continue }
        for (const ref of refs) if (typeof ref === 'string' && ref.startsWith('@image:') && !assets.has(ref.slice(7))) errors.push(`${label}: selected image is missing.`)
      }
    }
  }
  for (const f of content.fields) {
    if (f.namespace === 'nexus' || f.namespace.startsWith('shopify')) errors.push(`${fieldKey(f)} uses a reserved namespace.`)
    if (f.type.includes('metaobject_reference') && !f.metaobjectType) errors.push(`${fieldKey(f)} needs a metaobject type.`)
    if (f.metaobjectType && !content.metaobjectDefinitions.some(d => d.type === f.metaobjectType)) errors.push(`${fieldKey(f)}: metaobject definition is missing.`)
  }
  for (const a of content.assignments) {
    const target = a.target
    if (target.kind === 'options' && (!Object.keys(target.values).length || Object.keys(target.values).some(axis => !content.axes.includes(axis)) || !variants.some(v => matches(a, v)))) errors.push(`${a.name}: choose an existing option value or combination.`)
    if (target.kind === 'variant' && !variants.some(v => v.id === target.variantId)) errors.push(`${a.name}: variant no longer belongs to the family.`)
    if (a.gallery?.groupIds.some(id => !groups.has(id))) errors.push(`${a.name}: image group is missing.`)
    for (const [key, value] of Object.entries(a.values)) { const def = definitions.get(key); if (!def) errors.push(`${a.name}: undefined metafield ${key}.`); else checkValue(`${a.name} / ${key}`, def, value) }
  }
  for (const m of content.metaobjects) {
    const definition = content.metaobjectDefinitions.find(d => d.type === m.type)
    if (!definition) { errors.push(`${m.handle}: metaobject definition is missing.`); continue }
    for (const [key, value] of Object.entries(m.fields)) { const field = definition.fields.find(f => f.key === key); if (!field) errors.push(`${m.handle}: unknown field ${key}.`); else checkValue(`${m.handle} / ${key}`, field, value) }
  }
  for (const d of content.metaobjectDefinitions) {
    duplicate(d.fields.map(f => f.key), `fields in ${d.name}`)
    for (const f of d.fields) if (f.type.includes('metaobject_reference') && (!f.metaobjectType || !content.metaobjectDefinitions.some(def => def.type === f.metaobjectType))) errors.push(`${d.type}.${f.key}: metaobject definition is missing.`)
  }
  const acyclic = (items: { id: string; dependencies: string[] }[], label: string) => {
    const remaining = [...items], seen = new Set<string>()
    while (remaining.length) {
      const index = remaining.findIndex(item => item.dependencies.every(id => seen.has(id)))
      if (index < 0) { errors.push(`${label} contain a cycle or a missing reference.`); return }
      seen.add(remaining.splice(index, 1)[0].id)
    }
  }
  const nesting = (type: string, seen: string[] = []): number => seen.includes(type) ? 0 : 1 + Math.max(0, ...content.metaobjectDefinitions.find(d => d.type === type)?.fields.flatMap(f => f.metaobjectType ? [nesting(f.metaobjectType, [...seen, type])] : []) ?? [])
  for (const f of content.fields.filter(f => f.storefront && f.metaobjectType)) if (nesting(f.metaobjectType!) > 5) errors.push(`${fieldKey(f)}: generic storefront entries support up to five nested levels.`)
  acyclic(content.metaobjectDefinitions.map(d => ({ id: d.type, dependencies: d.fields.flatMap(f => f.metaobjectType ? [f.metaobjectType] : []) })), 'Metaobject definitions')
  acyclic(content.metaobjects.map(m => ({ id: m.id, dependencies: Object.entries(m.fields).filter(([key]) => content.metaobjectDefinitions.find(d => d.type === m.type)?.fields.find(f => f.key === key)?.type.includes('metaobject_reference')).flatMap(([, v]) => (v.value?.match(/@metaobject:([A-Za-z0-9_-]+)/g) ?? []).map(ref => ref.slice(12))) })), 'Reusable entries')
  for (const a of content.assets) for (const language of Object.keys(a.translations)) if (!content.locales.includes(language)) errors.push(`${a.alt || a.id}: add language ${language} before publishing its alt text.`)
  errors.push(...resolveShopifyContent(content, null).conflicts.map(e => `Family: ${e}`))
  for (const v of variants) errors.push(...resolveShopifyContent(content, v).conflicts.map(e => `${v.sku}: ${e}`))
  return unique(errors)
}

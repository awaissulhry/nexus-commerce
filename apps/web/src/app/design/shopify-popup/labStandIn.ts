/**
 * The lab's stand-in Shopify store (Lane B slice B0, docs/shopify-metafields/PLAN-2026-09-28.md §8).
 *
 * It answers the Shopify pop-up's calls for ONE made-up product — `/schema`, `/references`, `/reference-names`, `/entry`
 * (read and save) — from the made-up store in `@nexus/shared/shopify-lab-store`. It copies what the real server does today
 * (`apps/api/src/services/shopify/linked-products-gateway.ts`, `linked-metaobjects.service.ts`), including today's gaps
 * so the lab shows the truth. Pure:
 * `installLabShopify` wires it to `fetch`; the tests call it directly.
 *
 * Nothing leaves the browser tab. Saved entries live in memory until the page reloads or "Reset the lab".
 */
import { shopifyReferenceError, validateShopifyField, type ShopifyReference, type ShopifyReferencePage, type ShopifyReusableEntry } from '@nexus/shared/shopify-linked-products'
import { shopifyTaxonomyCategories } from '@nexus/shared/shopify-linked-products'
import { LAB_ENTRIES, LAB_ENTRY_KINDS, LAB_FILES, LAB_SCHEMA, LAB_TAXONOMY_VALUES, labEntryReference, labGid, labReferences, type LabEntry } from '@nexus/shared/shopify-lab-store'

/** The lab's Nexus product id. Only calls addressed to it are answered here. */
export const LAB_PRODUCT = 'design-lab-product'
export const LAB_PATH = `/api/products/${LAB_PRODUCT}/shopify-linked?accountId=lab&market=GLOBAL`
const PAGE = 40

interface LabState { entries: LabEntry[]; revisions: Map<string, number>; refuse: boolean; next: number }
const fresh = (): LabState => ({ entries: structuredClone(LAB_ENTRIES), revisions: new Map(), refuse: false, next: 5000 })
let state = fresh()

/** Back to the made-up store as shipped (entries, revisions and the refusal switch). */
export function resetLabStore() { state = fresh() }
/** When on, every entry save is answered with a Shopify refusal — to see how a refusal reads. */
export function setLabRefusal(on: boolean) { state.refuse = on }
/** Every reference, including entries saved in this tab. */
export const labStoreReferences = (): ShopifyReference[] => labReferences(state.entries)

export interface LabAnswer { status: number; body: unknown }
const ok = (body: unknown): LabAnswer => ({ status: 200, body })
const refuse = (status: number, error: string): LabAnswer => ({ status, body: { error } })

const RESOURCES: Record<string, string[]> = {
  product_reference: ['Product'], variant_reference: ['ProductVariant'], collection_reference: ['Collection'], page_reference: ['Page'],
  article_reference: ['Article'], customer_reference: ['Customer'], company_reference: ['Company'], order_reference: ['Order'],
  file_reference: ['MediaImage', 'Video', 'GenericFile'],
}

function search(params: URLSearchParams): LabAnswer {
  const type = (params.get('type') ?? '').replace(/^list\./, '')
  const query = (params.get('query') ?? '').trim().toLowerCase()
  const start = Number(params.get('cursor') ?? 0) || 0
  let items: ShopifyReference[]
  if (['metaobject_reference', 'mixed_reference', 'disclosure_reference'].includes(type)) {
    const kind = params.get('metaobjectType')
    if (!kind) return refuse(400, 'Choose the reusable entry type.')
    items = state.entries.filter(e => e.type === kind).map(labEntryReference)
  } else if (type === 'product_taxonomy_value_reference' && params.get('attribute')) {
    /* The attribute's own list, through a category the field applies to — like the gateway (B2, G12). */
    const attribute = params.get('attribute')!
    if (!(params.get('categories') ?? '').trim()) return refuse(422, `Shopify lists the “${attribute}” values only through a product category, and this field has none that carries it. The stored value is kept.`)
    items = LAB_TAXONOMY_VALUES.filter(v => v.attribute === attribute).map(({ attribute: _a, ...value }) => value)
  } else if (type === 'product_taxonomy_value_reference') {
    const raw = params.get('query') ?? ''
    return ok({ items: labStoreReferences().filter(r => r.id === raw && r.type === 'TaxonomyValue'), cursor: null } satisfies ShopifyReferencePage)
  } else if (RESOURCES[type]) {
    /* A file field limited to some kinds asks only for those (`fileTypes`, like the gateway's `media_type` filter). */
    const kinds = type === 'file_reference' && params.get('fileTypes')
      ? params.get('fileTypes')!.split(',').map(kind => ({ Image: 'MediaImage', Video: 'Video' } as Record<string, string>)[kind.trim()]).filter(Boolean)
      : RESOURCES[type]
    items = labStoreReferences().filter(r => kinds.includes(r.type ?? ''))
  } else return refuse(422, 'This reference type has no browser yet. Its existing value is preserved.')
  const matches = items.filter(item => !query || item.label.toLowerCase().includes(query))
  const page = matches.slice(start, start + PAGE)
  return ok({ items: page, cursor: start + PAGE < matches.length ? String(start + PAGE) : null } satisfies ShopifyReferencePage)
}

function names(body: unknown): LabAnswer {
  const ids = (body as { ids?: unknown })?.ids
  if (!Array.isArray(ids) || ids.length > 100) return refuse(400, 'Select at most 100 references at a time.')
  const all = labStoreReferences()
  return ok(ids.map(id => all.find(r => r.id === id) ?? { id, label: 'Unavailable reference', image: null, available: false }))
}

const kindOf = (type: string) => LAB_ENTRY_KINDS.find(kind => kind.type === type)
const revision = (id: string) => `lab-${state.revisions.get(id) ?? 0}`
function asReusable(entry: LabEntry): ShopifyReusableEntry {
  const definition = kindOf(entry.type)!
  return { id: entry.id, type: entry.type, handle: entry.handle, name: entry.name, revision: revision(entry.id), status: entry.status,
    fields: definition.fields.map(field => ({ key: field.key, type: field.type, value: entry.fields[field.key] ?? null })), definition, usedBy: [], moreUses: false }
}
/** The field an entry is named by in Shopify's lists (the kind's display field). */
const DISPLAY_KEYS = ['label', 'heading', 'title', 'question', 'quote', 'text']

function readEntry(id: string | null): LabAnswer {
  const entry = state.entries.find(e => e.id === id)
  return entry ? ok(asReusable(entry)) : refuse(404, 'This reusable entry is unavailable in the selected store.')
}

/** The same checks, in the same order and words, as `saveLinkedEntry` (linked-metaobjects.service.ts:19-63). */
function saveEntry(body: unknown): LabAnswer {
  const input = body as { id?: string; expectedRevision?: string; type?: string; handle?: string; status?: 'ACTIVE' | 'DRAFT'; fields?: Array<{ key: string; value: string }> }
  if (!input?.type || !input.handle || !/^[a-z0-9][a-z0-9-]{0,254}$/.test(input.handle) || !Array.isArray(input.fields)) return refuse(400, 'Choose an entry type, handle and valid fields.')
  const kind = kindOf(input.type)
  if (!kind) return refuse(422, 'This reusable entry type is no longer in the store. Reload the store schema.')
  if (input.status && !kind.publishable) return refuse(422, 'This entry type does not support a publication status.')
  if (new Set(input.fields.map(f => f.key)).size !== input.fields.length) return refuse(400, 'Each entry field must appear once.')
  let existing = input.id ? state.entries.find(e => e.id === input.id) ?? null : null
  if (input.id && !existing) return refuse(404, 'This reusable entry is unavailable in the selected store.')
  if (existing && (existing.type !== input.type || existing.handle !== input.handle)) return refuse(409, 'The entry identity changed. Reload before saving.')
  if (!input.id) existing = state.entries.find(e => e.type === input.type && e.handle === input.handle) ?? null
  const refs = labStoreReferences()
  for (const field of input.fields) {
    const def = kind.fields.find(d => d.key === field.key)
    if (!def) return refuse(422, `The entry field ${field.key} is no longer defined.`)
    if (def.readOnlyReason) return refuse(422, `${def.name} cannot be changed here: ${def.readOnlyReason}`)
    const error = validateShopifyField(def, field.value === '' ? null : field.value)
    if (error) return refuse(422, `${def.name}: ${error}`)
    if (def.type.includes('_reference') && field.value) {
      const ids: string[] = def.type.startsWith('list.') ? JSON.parse(field.value) : [field.value]
      const problem = shopifyReferenceError(def, ids.map(id => refs.find(r => r.id === id) ?? { available: false }), LAB_SCHEMA)
      if (problem) return refuse(422, problem)
      const handle = def.validations.find(v => v.name === 'product_taxonomy_attribute_handle')?.value
      if (handle && shopifyTaxonomyCategories(def, LAB_SCHEMA).length && ids.some(id => !LAB_TAXONOMY_VALUES.some(v => v.id === id && v.attribute === handle))) return refuse(422, `${def.name}: Choose a ${def.name} value from Shopify’s list.`)
    }
  }
  for (const def of kind.fields.filter(d => d.required)) {
    if (!(input.fields.find(f => f.key === def.key)?.value ?? existing?.fields[def.key])) return refuse(422, `${def.name}: Enter a value. Shopify needs this field.`)
  }
  if (existing && (!input.id || input.expectedRevision !== revision(existing.id))) return refuse(409, 'This entry changed in Shopify. Reload it before saving.')
  /* A Shopify `userErrors` answer reaches the pop-up today as the route's 502 with `ShopifyUserErrors`' text
     ("<operation>: <field path> <message>", admin-client.ts:91-100) — copied here word for word, so the lab shows it. */
  if (state.refuse) return refuse(502, `${existing ? 'Save' : 'Create'} reusable entry: metaobject.fields.0.value Value is invalid (made-up refusal: the lab switch "Answer with a Shopify refusal" is on).`)
  const fields = { ...(existing?.fields ?? {}), ...Object.fromEntries(input.fields.map(f => [f.key, f.value === '' ? null : f.value])) }
  const displayKey = DISPLAY_KEYS.find(key => kind.fields.some(f => f.key === key))
  const name = (displayKey && fields[displayKey]) || existing?.name || input.handle
  const picture = kind.fields.filter(f => f.type === 'file_reference').map(f => fields[f.key]).find(Boolean)
  const saved: LabEntry = {
    id: existing?.id ?? labGid('Metaobject', state.next++), type: kind.type, handle: input.handle, name,
    status: kind.publishable ? input.status ?? existing?.status ?? 'ACTIVE' : null, fields,
    image: picture ? LAB_FILES.find(f => f.id === picture)?.image ?? null : existing?.image ?? null,
    swatch: kind.type === 'shopify--color-pattern' ? fields.color ?? null : existing?.swatch ?? null,
  }
  state.entries = [...state.entries.filter(e => e.id !== saved.id), saved]
  state.revisions.set(saved.id, (state.revisions.get(saved.id) ?? 0) + 1)
  return ok(asReusable(saved))
}

/** The stand-in's answer, or `null` when the call is not for the lab product (it then goes to the real API untouched). */
export function answerLab(method: string, url: URL, body: unknown): LabAnswer | null {
  const [, rest] = url.pathname.split(`/api/products/${LAB_PRODUCT}/shopify-linked`)
  if (rest === undefined) return null
  if (method === 'GET' && rest === '/schema') return ok(LAB_SCHEMA)
  if (method === 'GET' && rest === '/references') return search(url.searchParams)
  if (method === 'POST' && rest === '/reference-names') return names(body)
  if (method === 'GET' && rest === '/entry') return readEntry(url.searchParams.get('id'))
  if (method === 'POST' && rest === '/entry') return saveEntry(body)
  return refuse(404, 'Not available in the lab.')
}

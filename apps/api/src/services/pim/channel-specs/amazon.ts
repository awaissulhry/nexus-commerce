/**
 * AM.1 — the Amazon adapter: ONE walker over a cached product-type definition.
 *
 * Replaces the three walkers that each hard-coded "one cell per attribute, skip anything needing
 * more than `value`, ignore `maxUniqueItems`" (`schema-to-fields.ts`, `schema-caps.ts`,
 * `mapping/field-catalogue.service.ts`) — they are projections of this one now. Measured on the
 * cached IT/OUTERWEAR definition (109 properties, 2026-09-04): those rules dropped 46 properties
 * and squashed 5 multi-valued ones into a single cell; across all 49 cached schemas 30% of what
 * Amazon declares had no shape at all. `docs/2026-09-04-channel-attribute-model-design.md` §2.
 *
 * The shape it walks (verified against the real cached definitions):
 *
 *   properties[name] = {
 *     type: 'array', minItems, maxUniqueItems, selectors: ['marketplace_id', 'language_tag', …],
 *     items: { type: 'object', required: [...], properties: {
 *       value: { type, maxLength, maxUtf8ByteLength, enum | anyOf[{enum}], enumNames, editable, hidden, $lifecycle },
 *       unit:  { enum: [...] },                       // a MEASURE when paired with `value`
 *       <leaf>: { type: 'array' | 'object' | scalar } // a COMPOUND leaf → `name__leaf`
 *       marketplace_id / language_tag: { $ref }       // selectors, never authored
 *     } } }
 *   root.required = ['brand', 'bullet_point', …]      // 'required'
 *   root.allOf = [{ if, then: { required: [...] } }]  // 'requiredIfRelevant'
 *   root.__propertyGroups = { offer: { title, propertyNames } … }   // localised titles
 *
 * Every property yields ≥ 1 spec (`coverage`). A shape this walker does not recognise yields a text
 * leaf AND an entry in `unrecognised`, which the test asserts empty — so a new Amazon shape is a
 * failing test, never a silently absent column. Pure and node-loadable; no prisma.
 */
import {
  humanizeKey, isProseKey, leafKey,
  type Cardinality, type ChannelFieldSpec, type ChannelGroup, type ChannelSpec, type ChannelStore,
  type LeafKind, type Requirement,
} from './types.js'

type Node = Record<string, any>

/** Sub-properties that are facet selectors on every attribute, never values an operator authors. */
const ALWAYS_SELECTORS = new Set(['marketplace_id', 'language_tag'])

/**
 * One concept, one column (Owner, 2026-09-05: "no duplications at all"). The Amazon attributes that
 * ARE a master field, by master key. The column carries Amazon's label, cap and requirement merged
 * onto the master field; on the Amazon scope it writes the listing's own store.
 */
export const AMAZON_MASTER_LINKS: Record<string, { masterKey: string; channelStore?: ChannelStore }> = {
  item_name: { masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } },
  product_description: { masterKey: 'description', channelStore: { kind: 'listingColumn', column: 'description', followFlag: 'followMasterDescription' } },
  bullet_point: { masterKey: 'bulletPoints', channelStore: { kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' } },
  generic_keyword: { masterKey: 'keywords' },
}

/**
 * Amazon attributes whose store is a LISTING COLUMN rather than the bag (no master twin). The
 * variation theme was the registry's `amazon_variationTheme` placeholder; the schema's own
 * `variation_theme` (with Amazon's enum) is the column now, on the same store.
 */
export const AMAZON_LISTING_STORES: Record<string, ChannelStore> = {
  variation_theme: { kind: 'listingColumn', column: 'variationTheme' },
}

/** Product type selects the schema, so it must remain editable even before a schema is cached. */
export function amazonClassificationSpec(marketplace: string): ChannelSpec {
  const group: ChannelGroup = { key: 'classification', label: 'Classification', channelLabel: null, order: 0 }
  return {
    channel: 'AMAZON', marketplace, category: '*', groups: [group], fetchedAt: null,
    schemaVersion: null, absent: false, unrecognised: [], coverage: { productType: ['productType'] },
    fields: [{ key: 'productType', attribute: 'productType', path: [], label: 'Product type', englishLabel: 'Product type',
      shape: 'scalar', kind: 'text', cardinality: { min: 1, max: 1 }, requirement: 'required', requiredInParent: true,
      editable: true, hidden: false, variantEligible: false, group,
      channelStore: { kind: 'platformAttributes', path: ['productType'] },
      helpText: 'Selects the Amazon attributes for this listing and marketplace.' }],
  }
}

export interface AmazonSpecInput {
  marketplace: string
  productType: string
  schemaDefinition: unknown
  fetchedAt?: Date | null
  schemaVersion?: string | null
}

export function amazonSpecFromDefinition(input: AmazonSpecInput): ChannelSpec {
  const root = (input.schemaDefinition ?? {}) as Node
  const properties = (root.properties ?? {}) as Record<string, Node>
  const rootRequired = new Set<string>(Array.isArray(root.required) ? root.required.map(String) : [])
  const conditional = conditionallyRequiredKeys(root)
  const { groups, byField } = readGroups(root)

  const fields: ChannelFieldSpec[] = []
  const coverage: Record<string, string[]> = {}
  const unrecognised: string[] = []

  for (const [name, prop] of Object.entries(properties)) {
    if (name.startsWith('__')) continue
    const requirement: Requirement = rootRequired.has(name) ? 'required' : conditional.has(name) ? 'requiredIfRelevant' : 'optional'
    const link = AMAZON_MASTER_LINKS[name]
    const produced = walkNode(name, prop, {
      attribute: name,
      path: [],
      requirement,
      requiredInParent: true,
      group: byField[name] ?? null,
      cardinality: { min: 1, max: 1 },
      selectors: [],
      title: null,
      unrecognised,
    })
    for (const f of produced) {
      if (link && f.path.length === 0) {
        f.masterKey = link.masterKey
        if (link.channelStore) f.channelStore = link.channelStore
      }
      const listingStore = AMAZON_LISTING_STORES[name]
      if (listingStore && f.path.length <= 1) f.channelStore = listingStore
    }
    coverage[name] = produced.map((f) => f.key)
    fields.push(...produced)
  }

  return {
    channel: 'AMAZON',
    marketplace: String(input.marketplace).toUpperCase(),
    category: String(input.productType).toUpperCase(),
    validationSchema: root,
    fields,
    groups,
    fetchedAt: input.fetchedAt ?? null,
    schemaVersion: input.schemaVersion ?? null,
    coverage,
    unrecognised,
    absent: false,
  }
}

// ────────────────────────────────────────────────────────────────────
// The walk
// ────────────────────────────────────────────────────────────────────

interface Inherited {
  attribute: string
  path: string[]
  requirement: Requirement
  requiredInParent: boolean
  group: ChannelGroup | null
  cardinality: Cardinality
  selectors: string[]
  /** The nearest enclosing title — a leaf without its own title inherits it. */
  title: string | null
  unrecognised: string[]
}

function walkNode(key: string, node: Node | undefined, inh: Inherited): ChannelFieldSpec[] {
  if (!node || typeof node !== 'object') return [unrecognisedLeaf(key, inh, 'not an object')]
  if (node.type === 'array') return walkArray(key, node, inh)
  if (node.type === 'object' || node.properties) return walkObject(key, node, inh)
  if (isScalar(node)) return [leaf(key, node, inh)]
  return [unrecognisedLeaf(key, inh, `type ${JSON.stringify(node.type ?? null)}`)]
}

function walkArray(key: string, node: Node, inh: Inherited): ChannelFieldSpec[] {
  const max = numOrNull(node.maxUniqueItems ?? node.maxItems)
  const min = numOrNull(node.minUniqueItems ?? node.minItems) ?? 1
  const cardinality: Cardinality = { min, max }
  const selectors = Array.isArray(node.selectors) ? node.selectors.map(String) : []
  const title = typeof node.title === 'string' ? node.title : inh.title
  const next: Inherited = { ...inh, cardinality, selectors: [...inh.selectors, ...selectors], title }
  const items = node.items
  if (!items || typeof items !== 'object') return [unrecognisedLeaf(key, next, 'array without items')]
  if (items.type === 'object' || items.properties) return walkObject(key, items, next)
  // An array of bare scalars (`color.standardized_values: { items: { type: 'string', anyOf } }`).
  if (isScalar(items)) return [leaf(key, items, next)]
  return [unrecognisedLeaf(key, next, `array of ${JSON.stringify(items.type ?? null)}`)]
}

function walkObject(key: string, obj: Node, inh: Inherited): ChannelFieldSpec[] {
  const props = (obj.properties ?? {}) as Record<string, Node>
  const required = new Set<string>(Array.isArray(obj.required) ? obj.required.map(String) : [])
  let authored = Object.keys(props).filter((k) => !ALWAYS_SELECTORS.has(k) && !inh.selectors.includes(k))
  // A KEYED SET: Amazon lists the value itself as the selector when the array is keyed by it
  // (`ghs_chemical_h_code`: selectors [marketplace_id, value]; `ghs.classification`: selectors
  // [class]). Removing the selectors leaves nothing to author, so the selector IS the leaf.
  if (authored.length === 0) authored = Object.keys(props).filter((k) => !ALWAYS_SELECTORS.has(k))
  const title = typeof obj.title === 'string' ? obj.title : inh.title
  const at = (k: string): Inherited => ({ ...inh, title, requiredInParent: required.has(k) })

  // A MEASURE: exactly { value, unit } with a closed unit list.
  if (authored.length === 2 && authored.includes('value') && authored.includes('unit') && isScalar(props.value) && Array.isArray(props.unit?.enum)) {
    return [measure(key, props.value, props.unit, at('value'))]
  }

  // The attribute's own value leaf, plus any sibling sub-properties as `key__sibling` leaves
  // (`color` + `color__standardized_values`, `hazmat` with `aspect` as a selector).
  if (authored.includes('value') && (isScalar(props.value) || props.value?.type === 'array')) {
    const out = walkNode(key, props.value, at('value'))
    for (const k of authored) {
      if (k === 'value') continue
      out.push(...walkNode(leafKey(key, k), props[k], { ...at(k), path: [...inh.path, k] }))
    }
    return out
  }

  // One authored sub-property that is not called `value` (`variation_theme.name`,
  // `image_locator_ps01.media_location`, `list_price.value_with_tax`, `inner.material`,
  // `closure.type`): the attribute IS that leaf, so it keeps the attribute's KEY — minimal keys —
  // while `path` records the sub-property, so the outbound writer can rebuild the nesting.
  if (authored.length === 1) {
    const k = authored[0]
    const sub = props[k]
    const subTitle = typeof sub?.title === 'string' ? sub.title : title
    return walkNode(key, sub, { ...at(k), path: [...inh.path, k], title: subTitle })
  }

  if (authored.length === 0) return [unrecognisedLeaf(key, { ...inh, title }, 'object with no authored sub-property')]

  // A COMPOUND: one leaf per authored sub-property (`closure__type`, `battery__weight`,
  // `fulfillment_availability__quantity`).
  const out: ChannelFieldSpec[] = []
  for (const k of authored) {
    out.push(...walkNode(leafKey(key, k), props[k], { ...at(k), path: [...inh.path, k] }))
  }
  return out
}

// ────────────────────────────────────────────────────────────────────
// Leaves
// ────────────────────────────────────────────────────────────────────

function isScalar(node: Node | undefined): boolean {
  if (!node || typeof node !== 'object') return false
  const t = node.type
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') return true
  if (Array.isArray(node.enum)) return true
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) return true
  return false
}

function enumOf(node: Node): { values: string[]; names?: string[]; open: boolean; booleans: boolean } | null {
  if (Array.isArray(node.enum)) {
    const booleans = node.enum.every((v: unknown) => typeof v === 'boolean')
    return { values: node.enum.map(String), names: Array.isArray(node.enumNames) ? node.enumNames.map(String) : undefined, open: false, booleans }
  }
  const alts = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (alts) {
    const withEnum = alts.find((a: Node) => Array.isArray(a?.enum))
    if (withEnum) {
      const plain = alts.some((a: Node) => !Array.isArray(a?.enum))
      return { values: withEnum.enum.map(String), names: Array.isArray(withEnum.enumNames) ? withEnum.enumNames.map(String) : undefined, open: plain, booleans: false }
    }
  }
  return null
}

function isDate(node: Node): boolean {
  if (node.format === 'date' || node.format === 'date-time') return true
  const alts = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : []
  return alts.length > 0 && alts.every((a: Node) => a?.format === 'date' || a?.format === 'date-time')
}

function kindOf(node: Node, key: string, attribute: string): LeafKind {
  const e = enumOf(node)
  if (node.type === 'boolean' || e?.booleans) return 'boolean'
  if (node.type === 'number' || node.type === 'integer') return 'number'
  if (isDate(node)) return 'date'
  if (e) return 'select'
  if (isProseKey(attribute) || isProseKey(key)) return 'longtext'
  return 'text'
}

function leaf(key: string, node: Node, inh: Inherited): ChannelFieldSpec {
  const e = enumOf(node)
  const kind = kindOf(node, key, inh.attribute)
  const options = kind === 'select' && e && e.values.length > 0 ? e.values : undefined
  let optionLabels: Record<string, string> | undefined
  if (options && e?.names && e.names.length === options.length) {
    optionLabels = {}
    options.forEach((code, i) => { optionLabels![code] = e.names![i] })
  }
  const lifecycle = (node.$lifecycle ?? {}) as Node
  const deprecatedRaw = Array.isArray(lifecycle.enumDeprecated) ? lifecycle.enumDeprecated.map(String) : []
  const deprecatedOptions = options ? deprecatedRaw.filter((d: string) => options.includes(d)) : []
  const maxLength = positive(node.maxLength)
  const maxBytes = positive(node.maxUtf8ByteLength)
  const title = typeof node.title === 'string' ? node.title : inh.title
  return {
    key,
    attribute: inh.attribute,
    path: inh.path,
    label: title ?? humanizeKey(key),
    shape: inh.cardinality.max === 1 ? 'scalar' : 'list',
    kind,
    cardinality: inh.cardinality,
    options,
    optionLabels,
    mode: options ? (e?.open ? 'open' : 'strict') : undefined,
    deprecatedOptions: deprecatedOptions.length > 0 ? deprecatedOptions : undefined,
    maxLength,
    maxBytes,
    requirement: inh.requirement,
    requiredInParent: inh.requiredInParent,
    editable: node.editable !== false,
    hidden: node.hidden === true,
    variantEligible: false,
    group: inh.group,
    helpText: typeof node.description === 'string' ? node.description : undefined,
    selectors: inh.selectors.length > 0 ? inh.selectors : undefined,
  }
}

function measure(key: string, valueNode: Node, unitNode: Node, inh: Inherited): ChannelFieldSpec {
  const base = leaf(key, valueNode, inh)
  return {
    ...base,
    shape: 'measure',
    kind: 'number',
    options: undefined,
    optionLabels: undefined,
    mode: undefined,
    unitOptions: unitNode.enum.map(String),
  }
}

function unrecognisedLeaf(key: string, inh: Inherited, why: string): ChannelFieldSpec {
  inh.unrecognised.push(`${key}: ${why}`)
  return {
    key,
    attribute: inh.attribute,
    path: inh.path,
    label: inh.title ?? humanizeKey(key),
    shape: inh.cardinality.max === 1 ? 'scalar' : 'list',
    kind: 'text',
    cardinality: inh.cardinality,
    requirement: inh.requirement,
    requiredInParent: inh.requiredInParent,
    editable: false,
    hidden: false,
    variantEligible: false,
    group: inh.group,
    helpText: `Structured value requires a supported editor (${why}). Saved values are preserved.`,
    selectors: inh.selectors.length > 0 ? inh.selectors : undefined,
  }
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ────────────────────────────────────────────────────────────────────
// Root-level facts (moved here from mapping/field-catalogue.service.ts, which now imports them)
// ────────────────────────────────────────────────────────────────────

/**
 * Field keys a conditional block would add to `required`. Amazon expresses "required if relevant"
 * as `allOf: [{ if: {...}, then: { required: [...] } }]`, sometimes nesting the requirement inside
 * `then.properties.<field>`. Measured on IT/OUTERWEAR: 44 keys (`reference_amazon_requirement_levels_derivation`).
 */
export function conditionallyRequiredKeys(def: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  const allOf = Array.isArray(def.allOf) ? (def.allOf as Record<string, unknown>[]) : []
  const collect = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 8) return
    const n = node as Record<string, unknown>
    if (Array.isArray(n.required)) for (const r of n.required) out.add(String(r))
    if (n.properties && typeof n.properties === 'object') {
      for (const k of Object.keys(n.properties as object)) out.add(k)
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') collect(v, depth + 1)
  }
  for (const block of allOf) if (block?.then) collect(block.then, 0)
  return out
}

/**
 * `__propertyGroups` at the schema ROOT (not inside `properties`) — verified 2026-09-01. Titles are
 * LOCALISED to the marketplace (`Offerta` on IT); the English label is the key humanised, because
 * the chrome is English (D10) and the channel's own term rides beside it.
 */
export function readGroups(def: Record<string, unknown>): {
  groups: ChannelGroup[]
  byField: Record<string, ChannelGroup>
} {
  const raw = def.__propertyGroups
  const groups: ChannelGroup[] = []
  const byField: Record<string, ChannelGroup> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    let order = 0
    for (const [key, g] of Object.entries(raw as Record<string, any>)) {
      const group: ChannelGroup = {
        key,
        label: humanizeKey(key),
        channelLabel: typeof g?.title === 'string' ? g.title : null,
        order,
      }
      groups.push(group)
      const names: unknown = g?.propertyNames
      if (Array.isArray(names)) for (const n of names) byField[String(n)] = group
      order++
    }
  }
  return { groups, byField }
}

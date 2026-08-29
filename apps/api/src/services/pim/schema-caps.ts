/**
 * MS.1 — the per-attribute limits the MASTER SHEET's cells need, read straight from a CACHED Amazon
 * product-type definition.
 *
 * Why not the flat-file manifest (`FlatFileColumn`, which carries all of this and more): building it
 * goes through `CategorySchemaService.getSchema`, which refreshes from SP-API whenever the cached
 * row is expired. The sheet's column list is fetched on every page load, so a live call there costs
 * seconds — and when the refresh token is revoked it THROWS, taking every product type's caps down
 * with it. Measured on the real IT catalogue 2026-08-29: every cached IT schema was structurally
 * complete (`__propertyGroups` present) but a month past its 24 h TTL, so the manifest path produced
 * zero caps for all four product types.
 *
 * A month-old cap is far better than no cap. A counter with no cap looks exactly like a cap of none,
 * and that is the dishonesty MS.1 exists to prevent — so this reads the cached definition whatever
 * its TTL and the caller REPORTS the age. Refreshing the cache is the schema-sync cron's job.
 *
 * The shape it walks (verified against a real cached COAT/IT schema):
 *   properties[name] = { type: 'array', required?: [...], items: {
 *     type: 'object', required: ['language_tag','value'],
 *     properties: { value: { type, maxLength, maxUtf8ByteLength, enum, enumNames, editable }, … } } }
 *   root.required = ['brand','bullet_point','item_name', …]
 */

export interface SchemaCap {
  /** Max length in CHARACTERS. */
  maxLength?: number
  /** Max length in UTF-8 BYTES — Amazon enforces this one, and an accented character is 2+ bytes. */
  maxBytes?: number
  options?: string[]
  optionLabels?: Record<string, string>
  /** The schema carries an enum, so the list is closed. */
  selectionOnly?: boolean
  required: boolean
  /** Amazon's `editable: false` — cannot be changed on an EXISTING listing. */
  editable: boolean
  label?: string
  helpText?: string
  /**
   * Enum values the type STILL offers but Amazon marks deprecated (`$lifecycle.enumDeprecated`).
   * A warning, never a block — a value dropped from the enum outright is already caught by the
   * closed-list check.
   */
  deprecatedOptions?: string[]
}

/** The sub-properties that are facet selectors, not values an operator types. */
const SELECTOR_KEYS = new Set(['language_tag', 'marketplace_id'])

/**
 * The node that actually holds the value. Most attributes use `value`; a few name it after the
 * attribute's own sub-field. Anything needing more than one authored sub-property (a value + unit
 * pair, say) does not fit one sheet cell and is skipped — the same rule `schema-to-fields.ts` uses.
 */
function valueNode(prop: Record<string, unknown>): Record<string, unknown> | null {
  const items = prop?.items as Record<string, unknown> | undefined
  if (!items || items.type !== 'object') return null
  const inner = items.properties as Record<string, Record<string, unknown>> | undefined
  if (!inner) return null

  const authored = Object.keys(inner).filter((k) => !SELECTOR_KEYS.has(k))
  const required = Array.isArray(items.required) ? (items.required as string[]) : []
  const authoredRequired = required.filter((r) => !SELECTOR_KEYS.has(r))
  // More than one authored-required sub-property (value + unit) cannot round-trip through a single
  // cell; reporting a cap for it would attach the cap to a cell that cannot write the attribute.
  if (authoredRequired.length > 1) return null

  if (inner.value) return inner.value
  if (authored.length === 1) return inner[authored[0]]
  return null
}

export function extractSchemaCaps(schemaDefinition: unknown): Record<string, SchemaCap> {
  const root = schemaDefinition as Record<string, unknown> | null
  if (!root || typeof root !== 'object') return {}

  const properties = (root.properties ?? {}) as Record<string, Record<string, unknown>>
  const requiredAtRoot = new Set<string>(Array.isArray(root.required) ? (root.required as string[]) : [])

  const out: Record<string, SchemaCap> = {}
  for (const [name, prop] of Object.entries(properties)) {
    if (name.startsWith('__')) continue
    const v = valueNode(prop)
    if (!v) continue

    const enumValues = Array.isArray(v.enum) ? (v.enum as unknown[]).map(String) : undefined
    const enumNames = Array.isArray(v.enumNames) ? (v.enumNames as unknown[]).map(String) : undefined

    let optionLabels: Record<string, string> | undefined
    if (enumValues && enumNames && enumNames.length === enumValues.length) {
      optionLabels = {}
      enumValues.forEach((code, i) => { optionLabels![code] = enumNames[i] })
    }

    const lifecycle = (v.$lifecycle ?? {}) as Record<string, unknown>
    const deprecatedRaw = Array.isArray(lifecycle.enumDeprecated) ? (lifecycle.enumDeprecated as unknown[]).map(String) : undefined
    // Only values the type still offers: one already removed from the enum is caught as off-list.
    const deprecatedOptions = deprecatedRaw && enumValues ? deprecatedRaw.filter((d) => enumValues.includes(d)) : undefined

    const maxLength = typeof v.maxLength === 'number' && v.maxLength > 0 ? v.maxLength : undefined
    const maxBytes = typeof v.maxUtf8ByteLength === 'number' && v.maxUtf8ByteLength > 0 ? v.maxUtf8ByteLength : undefined

    out[name] = {
      maxLength,
      maxBytes,
      options: enumValues && enumValues.length > 0 ? enumValues : undefined,
      optionLabels,
      selectionOnly: enumValues && enumValues.length > 0 ? true : undefined,
      required: requiredAtRoot.has(name),
      editable: v.editable !== false,
      label: typeof v.title === 'string' ? v.title : typeof prop.title === 'string' ? prop.title : undefined,
      helpText: typeof v.description === 'string' ? v.description : typeof prop.description === 'string' ? prop.description : undefined,
      deprecatedOptions: deprecatedOptions && deprecatedOptions.length > 0 ? deprecatedOptions : undefined,
    }
  }
  return out
}

export interface MergedCaps {
  caps: Record<string, SchemaCap>
  /** Which product types define each attribute. */
  definedBy: Record<string, string[]>
  /** Which product types REQUIRE it — a union sheet must not demand a COAT field from a GLOVE. */
  requiredBy: Record<string, string[]>
}

/**
 * Merge several product types' caps into one column set. The TIGHTEST cap wins (a value that fits
 * COAT but not GLOVES is refused for a glove), options are unioned, and required-ness is tracked per
 * type rather than collapsed to a boolean.
 */
export function mergeSchemaCaps(perType: Array<{ productType: string; caps: Record<string, SchemaCap> }>): MergedCaps {
  const caps: Record<string, SchemaCap> = {}
  const definedBy: Record<string, string[]> = {}
  const requiredBy: Record<string, string[]> = {}

  for (const { productType, caps: typeCaps } of perType) {
    for (const [name, cap] of Object.entries(typeCaps)) {
      definedBy[name] = [...(definedBy[name] ?? []), productType]
      if (cap.required) requiredBy[name] = [...(requiredBy[name] ?? []), productType]

      const existing = caps[name]
      if (!existing) {
        caps[name] = { ...cap }
        continue
      }
      caps[name] = {
        maxLength: pickTighter(existing.maxLength, cap.maxLength),
        maxBytes: pickTighter(existing.maxBytes, cap.maxBytes),
        options: unionOptions(existing.options, cap.options),
        optionLabels: { ...(existing.optionLabels ?? {}), ...(cap.optionLabels ?? {}) },
        // Closed only where EVERY type that defines it closes the list; otherwise a value legal for
        // one type would be flagged on a sheet that mixes types.
        selectionOnly: existing.selectionOnly && cap.selectionOnly ? true : undefined,
        required: existing.required || cap.required,
        editable: existing.editable && cap.editable,
        label: existing.label ?? cap.label,
        helpText: existing.helpText ?? cap.helpText,
        deprecatedOptions: unionOptions(existing.deprecatedOptions, cap.deprecatedOptions),
      }
      if (caps[name].optionLabels && Object.keys(caps[name].optionLabels!).length === 0) caps[name].optionLabels = undefined
    }
  }
  return { caps, definedBy, requiredBy }
}

function pickTighter(a?: number, b?: number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function unionOptions(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined
  return [...new Set([...(a ?? []), ...(b ?? [])])]
}

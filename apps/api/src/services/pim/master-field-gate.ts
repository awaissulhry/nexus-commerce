import { isChannelAttrField, isMappedChannelField } from './channel-field-map.js'

export const MASTER_FIELD_OPTIONS: Record<string, string[]> = {
  ppeCategory: ['CAT_I', 'CAT_II', 'CAT_III'],
  garmentClass: ['AAA', 'AA', 'A', 'B', 'C'],
}

/**
 * #775 — the master fields the ORDINARY cell edit may write, in a leaf so the
 * formula path and the sheet contract read the same gate the bulk PATCH
 * enforces.
 *
 * It was a `const` INSIDE the bulk PATCH handler, so nothing else could consult
 * it. The formula writer therefore kept its own narrower list of twelve, and the
 * contract advertised that list — meaning a formula could not write fields an
 * operator could type into by hand. The Owner's rule is "a formula can write
 * anything the operator can type", which is only true if there is ONE list.
 *
 * A LEAF: imports nothing, so both the route and the services can read it
 * without a cycle. Members are unchanged from the handler's set.
 */
export const ALLOWED_MASTER_FIELDS: ReadonlySet<string> = new Set([
    'sku',   // editable from master-data tab; uniqueness validated below
    'name',
    'description', // D.5: ZIP upload + grid editing
    'basePrice',
    'costPrice',
    'minMargin',
    'minPrice',
    'maxPrice',
    'totalStock',
    'lowStockThreshold',
    'brand',
    'manufacturer',
    'upc',
    'ean',
    'weightValue',
    // D.3j: weight/dim units + dim values
    'weightUnit',
    'dimLength',
    'dimWidth',
    'dimHeight',
    'dimUnit',
    // D.3k: master-level GTIN
    'gtin',
    'status',
    'fulfillmentChannel',
    // CC.1 — master Amazon productType. Drives the schema-driven
    // attribute set; per-listing override stays in
    // platformAttributes.productType (Q.5).
    'productType',
    // W1.4 — master long-form content + keyword tags. bulletPoints
    // and keywords are string[] columns on Product; the validator
    // below accepts both an array of strings and a JSON-string
    // payload (the bulk-ops grid pastes it as JSON, the master
    // editor sends it as an array).
    'bulletPoints',
    'keywords',
    // W1.4 — Italian fiscal / customs fields. hsCode is the
    // tariff classification (digit string) used by customs
    // declarations; countryOfOrigin is the ISO-2 alpha code used
    // on commercial invoices and Amazon attributes. Both flow
    // through PATCH /api/products/bulk so the master editor and
    // bulk-ops paste workflows share the same validator.
    'hsCode',
    'countryOfOrigin',
    // W7.1 — EU compliance: PPE directive category + ADR/IATA hazmat
    'ppeCategory',
    'hazmatClass',
    'hazmatUnNumber',
    // C4 — structured CE/PPE protective-gear data
    'garmentClass',
    'notifiedBodyNumber',
    'notifiedBodyName',
    'declarationOfConformityUrl',
    'impactProtectors',
    // GTIN.3 / Step 4 variant flow — the list-wizard's "promote to
    // parent" action PATCHes isParent=true and "link variant to
    // parent" PATCHes parentId. Both write into Product directly;
    // the wizard owned this surface but hit "Field not editable"
    // because the bulk allowlist didn't include them.
    'isParent',
    'parentId',
    ])

/**
 * THE gate: would the ordinary cell writer accept this WRITE FIELD?
 *
 * Asked of `writeField` — the name that goes on the wire in `changes[].field` —
 * never of the column key. #758 unified the predicate and still shipped two
 * gates, because the contract passed `writeField` and the writer passed the raw
 * key: `attr_batteries_included` is writable, `batteries_included` is not, and
 * the same function answered both. A shared function with two arguments is two
 * gates wearing one name.
 *
 * The mapped-channel half is IMPORTED, not restated. Writing the six prefixed
 * names out here would have been a second list of the same thing — the exact
 * mirror this file exists to remove, and I caught myself doing it.
 *
 * `attr_*` additionally needs a marketplace context and registry editability at
 * write time; those are per-request facts, not properties of the column, and the
 * bulk PATCH enforces them.
 */
export const writerAcceptsField = (writeField: string): boolean => {
  // AM.1 — a SLOT write field (`bulletPoints[3]`, `amazon_bulletPoints[3]`) is gated by its base:
  // the writer validates the base field and lands the slot as one array write.
  const base = writeField.replace(/\[\d+\]$/, '')
  return ALLOWED_MASTER_FIELDS.has(base) || isChannelAttrField(base) || isMappedChannelField(base)
}

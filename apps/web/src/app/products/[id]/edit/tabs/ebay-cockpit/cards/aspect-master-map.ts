// EC.5 — Master → eBay aspect default mapping.
//
// Tiny lookup table that lets the Field Source System's "From Master"
// option produce a sensible value for common eBay aspects without
// the operator having to wire each one. Names are matched against
// the eBay aspect NAME (which is per-marketplace localised, so the
// table includes both English and Italian variants).
//
// EC.5 ships this as a static map for the substrate. A future phase
// (EC.5b or a /settings/ebay-aspect-mappings admin page) hoists
// these into a `CategoryAspectMapping` Prisma table so operators
// can extend the catalog per-category without a code deploy.

interface MasterLike {
  brand?: string | null
  color?: string | null
  size?: string | null
  material?: string | null
  gender?: string | null
  productType?: string | null
  weightG?: number | null
  countryOfOrigin?: string | null
  mpn?: string | null
  gtin?: string | null
  ean?: string | null
  upc?: string | null
}

type Resolver = (m: MasterLike) => string | null

/** Case-insensitive aspect-name → master resolver lookup. Keys are
 *  lowered before lookup so a single entry covers "Brand" / "brand"
 *  / "BRAND" alike. Localised aspect names ship as additional keys
 *  pointing to the same resolver. */
const REGISTRY: Record<string, Resolver> = {
  // ── Brand ─────────────────────────────────────────────
  'brand':    (m) => m.brand ?? null,
  'marca':    (m) => m.brand ?? null,   // IT
  'marke':    (m) => m.brand ?? null,   // DE
  'marque':   (m) => m.brand ?? null,   // FR
  'marca/fabricante': (m) => m.brand ?? null,  // ES

  // ── Color ─────────────────────────────────────────────
  'colour':         (m) => m.color ?? null,
  'color':          (m) => m.color ?? null,
  'main colour':    (m) => m.color ?? null,
  'colore':         (m) => m.color ?? null,    // IT
  'farbe':          (m) => m.color ?? null,    // DE
  'couleur':        (m) => m.color ?? null,    // FR

  // ── Size ──────────────────────────────────────────────
  'size':     (m) => m.size ?? null,
  'taglia':   (m) => m.size ?? null,    // IT
  'größe':    (m) => m.size ?? null,    // DE
  'taille':   (m) => m.size ?? null,    // FR
  'talla':    (m) => m.size ?? null,    // ES

  // ── Material ──────────────────────────────────────────
  'material': (m) => m.material ?? null,
  'materiale': (m) => m.material ?? null,   // IT

  // ── Department / Gender ───────────────────────────────
  'department':  (m) => m.gender ?? null,
  'gender':      (m) => m.gender ?? null,
  'dipartimento': (m) => m.gender ?? null,  // IT

  // ── Country of origin ─────────────────────────────────
  'country/region of manufacture': (m) => m.countryOfOrigin ?? null,
  'país de fabricación':           (m) => m.countryOfOrigin ?? null,
  'paese di fabbricazione':        (m) => m.countryOfOrigin ?? null,

  // ── MPN / GTIN / barcodes ─────────────────────────────
  'mpn':  (m) => m.mpn ?? null,
  'gtin': (m) => m.gtin ?? m.ean ?? m.upc ?? null,
  'ean':  (m) => m.ean ?? m.gtin ?? null,
  'upc':  (m) => m.upc ?? m.gtin ?? null,
  'codice prodotto del produttore': (m) => m.mpn ?? null, // IT MPN

  // ── Weight (g) ───────────────────────────────────────
  'item weight': (m) => (m.weightG != null ? String(m.weightG) : null),
  'peso':        (m) => (m.weightG != null ? String(m.weightG) : null),
}

/** Resolve an aspect to its master-derived value (or null if the
 *  registry has no mapping for that name). */
export function resolveMasterValue(
  aspectName: string,
  master: MasterLike,
): string | null {
  const key = aspectName.trim().toLowerCase()
  // Split on " (" so "Marca (Brand)" first tries the localised name
  // then the parenthesised English fallback.
  const candidates = [key, key.split(' (')[0]?.trim(), key.split(' (')[1]?.replace(')', '').trim()]
    .filter((s): s is string => !!s && s.length > 0)
  for (const c of candidates) {
    const r = REGISTRY[c]
    if (r) {
      const v = r(master)
      if (v != null && v !== '') return v
    }
  }
  return null
}

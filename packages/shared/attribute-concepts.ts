/**
 * The concept catalogue — common product facts, and what each channel calls them.
 *
 * `docs/attributes/PLAN.md` §4.1 (P3). A CONCEPT is one fact about a product (its colour, its size, its brand). A
 * business's own attribute links to a concept through `CustomAttribute.semanticKey`; a Nexus master field IS a concept
 * when `masterField` is set. The channel bindings then say which channel field carries the same fact, so a link needs
 * no setup (PLAN §4.3).
 *
 * Rules for this file (each one has a test in `attribute-concepts.vitest.test.ts`):
 *   · A binding is a CANDIDATE. A link is made only when the channel's spec for the exact (market × category)
 *     declares that field — a name listed here that the channel does not use links nothing.
 *   · A channel field name belongs to at most ONE concept, per channel. Two concepts claiming it would be a guess.
 *   · eBay names are listed in English AND in the marketplace languages, because the aspect cache keys some
 *     categories by the localized name (`aspect_Colore`, `aspect_Farbe` were measured in stored listings).
 *   · Value synonyms are for MATCHING a value to a channel's list (P5). The stored value is never rewritten from them.
 *   · Adding a channel = one more key in `bindings` for the concepts it carries. Nothing else changes.
 *
 * Pure: no I/O, safe for the browser.
 */
import type { AttributeChannel, AttributeLeafKind, AttributeShape } from './attributes'

export const CONCEPTS_REVISION = '2026-10-05.1'

export type ConceptGroup = 'content' | 'identity' | 'identifiers' | 'variation' | 'specifications' | 'dimensions' | 'compliance'

export interface AttributeConcept {
  /** Stable key. Also the attribute CODE a starter dictionary creates. Never renamed. */
  key: string
  /** English (the chrome is English). */
  label: string
  group: ConceptGroup
  shape: AttributeShape
  kind: AttributeLeafKind
  /** `per_variant` = a variation axis (one value per child). */
  scope: 'global' | 'per_variant'
  localizable: boolean
  /** The Nexus master field that already holds this fact. Such a concept is never created as a custom attribute. */
  masterField?: string
  /** Other attribute codes a business may already use for this fact; a code equal to `key` is always tried first. */
  adoptCodes?: string[]
  unitOptions?: string[]
  /** Channel field names that carry this fact, in priority order. Candidates only — see the file header. */
  bindings: Partial<Record<AttributeChannel, string[]>>
  /** Canonical value code → its spellings (English first, then IT, DE, FR, ES). Matching only. */
  valueSynonyms?: Record<string, string[]>
  /**
   * A value's label in each language, where the words differ (`black` → Nero, Schwarz…). The options a concept seeds
   * take their `label` and `metadata.labels` from here; a value without an entry is written the same in every language
   * (`XS`). Every text here is also one of the value's `valueSynonyms` (pinned by the tests).
   */
  valueLabels?: Record<string, ValueLabels>
}

export type ValueLanguage = 'en' | 'it' | 'de' | 'fr' | 'es'
export type ValueLabels = Readonly<Record<ValueLanguage, string>>
const labels = (en: string, it: string, de: string, fr: string, es: string): ValueLabels => ({ en, it, de, fr, es })

/** The option code a concept value is stored under (`XS` → `xs`, `one_size` → `one_size`). Codes never change. */
export function conceptOptionCode(valueCode: string): string {
  return valueCode.toLowerCase().replace(/[^a-z0-9_]+/g, '_')
}

/** English, Italian, German, French, Spanish — in that order, repeats removed (`Marca` is IT and ES). */
const EU = (en: string, it: string, de: string, fr: string, es: string) => [...new Set([en, it, de, fr, es])]

export const ATTRIBUTE_CONCEPTS: readonly AttributeConcept[] = [
  // ── Content (master fields) ──────────────────────────────────────
  { key: 'title', label: 'Title', group: 'content', shape: 'scalar', kind: 'text', scope: 'global', localizable: true, masterField: 'name',
    bindings: { AMAZON: ['item_name'], EBAY: ['title'], SHOPIFY: ['title'], ETSY: ['title'] } },
  { key: 'description', label: 'Description', group: 'content', shape: 'scalar', kind: 'longtext', scope: 'global', localizable: true, masterField: 'description',
    bindings: { AMAZON: ['product_description'], EBAY: ['description'], SHOPIFY: ['descriptionHtml'], ETSY: ['description'] } },
  { key: 'bullet_points', label: 'Bullet points', group: 'content', shape: 'list', kind: 'longtext', scope: 'global', localizable: true, masterField: 'bulletPoints',
    bindings: { AMAZON: ['bullet_point'] } },
  { key: 'search_keywords', label: 'Search keywords', group: 'content', shape: 'list', kind: 'text', scope: 'global', localizable: true, masterField: 'keywords',
    bindings: { AMAZON: ['generic_keyword'], ETSY: ['tags'] } },

  // ── Identity (master fields) ─────────────────────────────────────
  { key: 'brand', label: 'Brand', group: 'identity', shape: 'scalar', kind: 'text', scope: 'global', localizable: false, masterField: 'brand',
    bindings: { AMAZON: ['brand'], EBAY: EU('Brand', 'Marca', 'Marke', 'Marque', 'Marca'), SHOPIFY: ['vendor'] } },
  { key: 'manufacturer', label: 'Manufacturer', group: 'identity', shape: 'scalar', kind: 'text', scope: 'global', localizable: false, masterField: 'manufacturer',
    bindings: { AMAZON: ['manufacturer'], EBAY: EU('Manufacturer', 'Produttore', 'Hersteller', 'Fabricant', 'Fabricante') } },
  { key: 'model_number', label: 'Model number', group: 'identity', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    bindings: { AMAZON: ['model_number', 'part_number'], EBAY: ['MPN'] } },
  { key: 'model_name', label: 'Model name', group: 'identity', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    bindings: { AMAZON: ['model_name'], EBAY: EU('Model', 'Modello', 'Modell', 'Modèle', 'Modelo') } },

  // ── Identifiers (master fields) ──────────────────────────────────
  { key: 'gtin', label: 'GTIN', group: 'identifiers', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false, masterField: 'gtin',
    bindings: { AMAZON: ['externally_assigned_product_identifier__value'], EBAY: ['GTIN'] } },
  { key: 'ean', label: 'EAN', group: 'identifiers', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false, masterField: 'ean',
    bindings: { EBAY: ['EAN'], SHOPIFY: ['barcode'] } },
  { key: 'upc', label: 'UPC', group: 'identifiers', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false, masterField: 'upc',
    bindings: { EBAY: ['UPC'] } },

  // ── Variation axes ───────────────────────────────────────────────
  { key: 'color', label: 'Color', group: 'variation', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false,
    adoptCodes: ['colour', 'color_name'],
    bindings: { AMAZON: ['color'], EBAY: ['Color', 'Colour', 'Colore', 'Farbe', 'Couleur'], SHOPIFY: ['shopify.color-pattern'], ETSY: ['primary_color', 'color'] },
    valueSynonyms: {
      black: EU('Black', 'Nero', 'Schwarz', 'Noir', 'Negro'), white: EU('White', 'Bianco', 'Weiß', 'Blanc', 'Blanco'),
      grey: ['Grey', 'Gray', 'Grigio', 'Grau', 'Gris'], red: EU('Red', 'Rosso', 'Rot', 'Rouge', 'Rojo'),
      blue: EU('Blue', 'Blu', 'Blau', 'Bleu', 'Azul'), green: EU('Green', 'Verde', 'Grün', 'Vert', 'Verde'),
      yellow: EU('Yellow', 'Giallo', 'Gelb', 'Jaune', 'Amarillo'), orange: [...EU('Orange', 'Arancione', 'Orange', 'Orange', 'Naranja'), 'Arancia'],
      brown: EU('Brown', 'Marrone', 'Braun', 'Marron', 'Marrón'), pink: EU('Pink', 'Rosa', 'Rosa', 'Rose', 'Rosa'),
      purple: EU('Purple', 'Viola', 'Lila', 'Violet', 'Morado'), beige: EU('Beige', 'Beige', 'Beige', 'Beige', 'Beige'),
      multicolour: ['Multicolour', 'Multicolor', 'Multicolore', 'Mehrfarbig', 'Multicolore', 'Multicolor'],
    },
    valueLabels: {
      black: labels('Black', 'Nero', 'Schwarz', 'Noir', 'Negro'), white: labels('White', 'Bianco', 'Weiß', 'Blanc', 'Blanco'),
      grey: labels('Grey', 'Grigio', 'Grau', 'Gris', 'Gris'), red: labels('Red', 'Rosso', 'Rot', 'Rouge', 'Rojo'),
      blue: labels('Blue', 'Blu', 'Blau', 'Bleu', 'Azul'), green: labels('Green', 'Verde', 'Grün', 'Vert', 'Verde'),
      yellow: labels('Yellow', 'Giallo', 'Gelb', 'Jaune', 'Amarillo'), orange: labels('Orange', 'Arancione', 'Orange', 'Orange', 'Naranja'),
      brown: labels('Brown', 'Marrone', 'Braun', 'Marron', 'Marrón'), pink: labels('Pink', 'Rosa', 'Rosa', 'Rose', 'Rosa'),
      purple: labels('Purple', 'Viola', 'Lila', 'Violet', 'Morado'), beige: labels('Beige', 'Beige', 'Beige', 'Beige', 'Beige'),
      multicolour: labels('Multicolour', 'Multicolore', 'Mehrfarbig', 'Multicolore', 'Multicolor'),
    } },
  { key: 'size', label: 'Size', group: 'variation', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false,
    bindings: { AMAZON: ['size', 'apparel_size__size'], EBAY: ['Size', 'Taglia', 'Größe', 'Taille', 'Talla'], SHOPIFY: ['shopify.size'], ETSY: ['size'] },
    valueSynonyms: {
      XXS: ['XXS'], XS: ['XS'], S: ['S'], M: ['M'], L: ['L'], XL: ['XL'], XXL: ['XXL', '2XL'], '3XL': ['3XL', 'XXXL'], '4XL': ['4XL', 'XXXXL'], '5XL': ['5XL'],
      one_size: EU('One Size', 'Taglia unica', 'Einheitsgröße', 'Taille unique', 'Talla única'),
    },
    valueLabels: { one_size: labels('One Size', 'Taglia unica', 'Einheitsgröße', 'Taille unique', 'Talla única') } },
  { key: 'size_system', label: 'Size system', group: 'variation', shape: 'scalar', kind: 'select', scope: 'global', localizable: false,
    bindings: { AMAZON: ['apparel_size__size_system'] },
    valueSynonyms: {
      INT: ['International letters', 'Alpha'], EU: ['European'], UK: ['United Kingdom', 'GB'], US: ['United States'],
      IT: ['Italy', 'Italia'], FR: ['France'], DE: ['Germany', 'Deutschland'],
    } },

  // ── Specifications ───────────────────────────────────────────────
  { key: 'material', label: 'Material', group: 'specifications', shape: 'list', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['materials'],
    bindings: { AMAZON: ['material'], EBAY: ['Material', 'Materiale', 'Matière', 'Outer Shell Material'], SHOPIFY: ['shopify.fabric', 'shopify.material'], ETSY: ['material', 'materials'] },
    valueSynonyms: {
      polyester: EU('Polyester', 'Poliestere', 'Polyester', 'Polyester', 'Poliéster'), cotton: EU('Cotton', 'Cotone', 'Baumwolle', 'Coton', 'Algodón'),
      leather: EU('Leather', 'Pelle', 'Leder', 'Cuir', 'Cuero'), wool: EU('Wool', 'Lana', 'Wolle', 'Laine', 'Lana'),
      nylon: EU('Nylon', 'Nylon', 'Nylon', 'Nylon', 'Nailon'), polyamide: EU('Polyamide', 'Poliammide', 'Polyamid', 'Polyamide', 'Poliamida'),
      elastane: EU('Elastane', 'Elastan', 'Elastan', 'Élasthanne', 'Elastano'), mesh: EU('Mesh', 'Rete', 'Netz', 'Maille', 'Malla'),
    } },
  { key: 'fabric_type', label: 'Fabric description', group: 'specifications', shape: 'scalar', kind: 'longtext', scope: 'global', localizable: true,
    bindings: { AMAZON: ['fabric_type'] } },
  { key: 'lining', label: 'Lining', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: true,
    adoptCodes: ['lining_description'],
    bindings: { AMAZON: ['lining_description'], EBAY: EU('Lining Material', 'Materiale fodera', 'Futtermaterial', 'Matière de la doublure', 'Material del forro') } },
  { key: 'pattern', label: 'Pattern', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: true,
    adoptCodes: ['pattern_type'],
    bindings: { AMAZON: ['pattern'], EBAY: EU('Pattern', 'Fantasia', 'Muster', 'Motif', 'Estampado'), SHOPIFY: ['shopify.pattern'], ETSY: ['pattern'] },
    valueSynonyms: { solid: EU('Solid', 'Tinta unita', 'Einfarbig', 'Uni', 'Liso'), striped: EU('Striped', 'A righe', 'Gestreift', 'Rayé', 'A rayas') } },
  { key: 'style', label: 'Style', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: true,
    bindings: { AMAZON: ['style'], EBAY: EU('Style', 'Stile', 'Stil', 'Style', 'Estilo'), ETSY: ['style'] } },
  { key: 'target_gender', label: 'Target gender', group: 'specifications', shape: 'scalar', kind: 'select', scope: 'global', localizable: false,
    bindings: { AMAZON: ['target_gender', 'department'], EBAY: EU('Department', 'Reparto', 'Abteilung', 'Département', 'Departamento'), SHOPIFY: ['shopify.target-gender'] },
    valueSynonyms: {
      men: ['Men', 'Male', "Men's", 'Uomo', 'Herren', 'Homme', 'Hombre'], women: ['Women', 'Female', "Women's", 'Donna', 'Damen', 'Femme', 'Mujer'],
      // 'Mixte' (2026-10-05): Amazon FR's adult unisex department word.
      unisex: ['Unisex', 'Unisex-adult', 'Unisex adulto', 'Unisex-Erwachsene', 'Unisexe', 'Mixte'],
    } },
  { key: 'age_group', label: 'Age group', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['age_range_description'],
    bindings: { AMAZON: ['age_range_description'], SHOPIFY: ['shopify.age-group'] } },
  { key: 'fit', label: 'Fit', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['fit_type'],
    bindings: { AMAZON: ['fit_type'], EBAY: EU('Fit', 'Vestibilità', 'Passform', 'Coupe', 'Corte'), SHOPIFY: ['shopify.fit'] } },
  { key: 'closure', label: 'Closure', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: true,
    bindings: { AMAZON: ['closure__type'], EBAY: EU('Closure', 'Chiusura', 'Verschluss', 'Fermeture', 'Cierre'), SHOPIFY: ['shopify.closure-type'] } },
  { key: 'neckline', label: 'Neckline', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'per_variant', localizable: false,
    adoptCodes: ['collar_style'],
    bindings: { AMAZON: ['neck__neck_style', 'collar_style'], EBAY: EU('Neckline', 'Scollatura', 'Ausschnitt', 'Encolure', 'Cuello'), SHOPIFY: ['shopify.neckline'] } },
  { key: 'sleeve_length', label: 'Sleeve length', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['sleeve__length_description'],
    bindings: { AMAZON: ['sleeve__length_description'], EBAY: EU('Sleeve Length', 'Lunghezza manica', 'Ärmellänge', 'Longueur des manches', 'Largo de manga'), SHOPIFY: ['shopify.sleeve-length-type'] } },
  { key: 'season', label: 'Season', group: 'specifications', shape: 'list', kind: 'text', scope: 'global', localizable: true,
    adoptCodes: ['seasons'],
    bindings: { AMAZON: ['seasons'], EBAY: EU('Season', 'Stagione', 'Saison', 'Saison', 'Temporada') },
    valueSynonyms: {
      spring: EU('Spring', 'Primavera', 'Frühling', 'Printemps', 'Primavera'), summer: EU('Summer', 'Estate', 'Sommer', 'Été', 'Verano'),
      autumn: ['Autumn', 'Fall', 'Autunno', 'Herbst', 'Automne', 'Otoño'], winter: EU('Winter', 'Inverno', 'Winter', 'Hiver', 'Invierno'),
      all_seasons: EU('All Seasons', 'Tutte le stagioni', 'Ganzjährig', 'Toutes saisons', 'Todas las estaciones'),
    } },
  { key: 'features', label: 'Features', group: 'specifications', shape: 'list', kind: 'text', scope: 'global', localizable: true,
    adoptCodes: ['special_feature'],
    bindings: { AMAZON: ['special_feature'], EBAY: EU('Features', 'Caratteristiche', 'Besonderheiten', 'Caractéristiques', 'Características'), SHOPIFY: ['shopify.clothing-features'] } },
  { key: 'theme', label: 'Theme', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: true,
    bindings: { AMAZON: ['theme'], EBAY: EU('Theme', 'Tema', 'Thema', 'Thème', 'Tema') } },
  { key: 'occasion', label: 'Occasion', group: 'specifications', shape: 'list', kind: 'text', scope: 'global', localizable: true,
    bindings: { AMAZON: ['occasion_type'], EBAY: EU('Occasion', 'Occasione', 'Anlass', 'Occasion', 'Ocasión'), ETSY: ['occasion'] } },
  { key: 'care_instructions', label: 'Care instructions', group: 'specifications', shape: 'scalar', kind: 'longtext', scope: 'global', localizable: true,
    bindings: { AMAZON: ['care_instructions'], EBAY: ['Garment Care'] } },
  { key: 'water_resistance', label: 'Water resistance', group: 'specifications', shape: 'scalar', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['water_resistance_level'],
    bindings: { AMAZON: ['water_resistance_level'] } },

  // ── Compliance (master fields and PPE) ───────────────────────────
  { key: 'country_of_origin', label: 'Country of origin', group: 'compliance', shape: 'scalar', kind: 'select', scope: 'global', localizable: false, masterField: 'countryOfOrigin',
    bindings: { AMAZON: ['country_of_origin'], EBAY: EU('Country/Region of Manufacture', 'Paese di fabbricazione', 'Herstellungsland und -region', 'Pays de fabrication', 'País de fabricación'), SHOPIFY: ['countryCodeOfOrigin'] } },
  { key: 'hs_code', label: 'HS code', group: 'compliance', shape: 'scalar', kind: 'text', scope: 'global', localizable: false, masterField: 'hsCode',
    bindings: { SHOPIFY: ['harmonizedSystemCode'] } },
  { key: 'certification', label: 'Certification', group: 'compliance', shape: 'list', kind: 'text', scope: 'global', localizable: false,
    adoptCodes: ['ce_certification', 'ceCertification'],
    bindings: { EBAY: EU('Certification', 'Certificazione', 'Zertifizierung', 'Certification', 'Certificación') } },

  // ── Dimensions (master fields) ───────────────────────────────────
  { key: 'item_weight', label: 'Item weight', group: 'dimensions', shape: 'measure', kind: 'number', scope: 'per_variant', localizable: false, masterField: 'weightValue',
    unitOptions: ['g', 'kg', 'oz', 'lb'],
    bindings: { AMAZON: ['item_weight'], SHOPIFY: ['weight'] } },
]

// ────────────────────────────────────────────────────────────────────
// Lookups
// ────────────────────────────────────────────────────────────────────

/**
 * The join token for a field name: accents folded, `aspect_` prefix and case dropped, non-alphanumerics removed.
 * `aspect_Colore` → `colore`, `Größe` → `grosse`, `Country/Region of Manufacture` → `countryregionofmanufacture`.
 * (Diacritics are folded BEFORE stripping, as `channel-specs/types.ts` does; `ß` becomes `ss`.)
 */
export function conceptFieldToken(name: string): string {
  return name
    .replace(/^aspect_/, '')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const byKey = new Map(ATTRIBUTE_CONCEPTS.map(concept => [concept.key, concept]))

export function conceptByKey(key: string | null | undefined): AttributeConcept | undefined {
  return key ? byKey.get(key) : undefined
}

const byChannelToken = new Map<string, AttributeConcept>()
for (const concept of ATTRIBUTE_CONCEPTS) {
  for (const [channel, names] of Object.entries(concept.bindings) as Array<[AttributeChannel, string[]]>) {
    for (const name of names) byChannelToken.set(`${channel}:${conceptFieldToken(name)}`, concept)
  }
}

/** The concept a channel field carries, by its key (or label), or undefined. */
export function conceptForChannelField(channel: AttributeChannel, fieldKey: string, label?: string | null): AttributeConcept | undefined {
  return byChannelToken.get(`${channel}:${conceptFieldToken(fieldKey)}`)
    ?? (label ? byChannelToken.get(`${channel}:${conceptFieldToken(label)}`) : undefined)
}

/**
 * The canonical value code a spelling stands for within a concept (`Nero` → `black` for colour), or undefined.
 * Case- and accent-insensitive. Matching only — see the file header.
 */
export function conceptValueCode(concept: AttributeConcept, value: string): string | undefined {
  const token = conceptFieldToken(value)
  if (!token || !concept.valueSynonyms) return undefined
  for (const [code, spellings] of Object.entries(concept.valueSynonyms)) {
    if (conceptFieldToken(code) === token || spellings.some(spelling => conceptFieldToken(spelling) === token)) return code
  }
  return undefined
}

/** Concepts a business creates as its own attributes (the rest are master fields already). */
export function customAttributeConcepts(): AttributeConcept[] {
  return ATTRIBUTE_CONCEPTS.filter(concept => !concept.masterField)
}

export type ValueMatch = { to: string; how: 'exact' | 'synonym' }

/**
 * P5 (docs/attributes/PLAN.md §4.3) — the channel option a value stands for, or null. `options` are the codes the
 * channel accepts (what is sent); `optionLabels` their display names (Etsy sends ids and shows names).
 *   1. exact — the same text, ignoring case and accents (`nero` → `Nero`; a label match returns its code);
 *   2. synonym — the concept's value synonyms say both mean the same (`Nero` → `Black`).
 * Nothing else: translation and AI suggestions are review-gated elsewhere, never applied as a match.
 * A value that already IS an option is returned as an exact match to itself.
 */
export function matchConceptValue(concept: AttributeConcept | undefined, value: string, options: readonly string[], optionLabels?: Readonly<Record<string, string>> | null): ValueMatch | null {
  const token = conceptFieldToken(value)
  if (!token) return null
  const names = options.map(code => ({ code, tokens: [conceptFieldToken(code), ...(optionLabels?.[code] ? [conceptFieldToken(optionLabels[code])] : [])] }))
  const exact = names.find(option => option.tokens.includes(token))
  if (exact) return { to: exact.code, how: 'exact' }
  if (!concept) return null
  const code = conceptValueCode(concept, value)
  if (!code) return null
  const synonym = names.find(option => [option.code, optionLabels?.[option.code]].some(name => name && conceptValueCode(concept, name) === code))
  return synonym ? { to: synonym.code, how: 'synonym' } : null
}

/**
 * Item 1 (product sheet consistency, 2026-10-05) — the ONE channel option a value means by the concept's synonyms, or
 * null. Used when a value is resolved for a channel list (`men` → Amazon `male`, `men` → Amazon IT department `Uomo`).
 *   · null when the value already IS an option — its code or its label, ignoring case and accents: the channel
 *     validator's own spelling rules take it from there;
 *   · null when the concept does not know the value, or when TWO or more options share its meaning (never a guess);
 *   · otherwise the option's CODE (what is sent).
 * Matching only: the stored value is never rewritten.
 */
export function conceptSynonymOption(concept: AttributeConcept | undefined, value: string, options: readonly string[], optionLabels?: Readonly<Record<string, string>> | null): string | null {
  if (!concept?.valueSynonyms || !options.length) return null
  const token = conceptFieldToken(value)
  if (!token) return null
  if (options.some(code => conceptFieldToken(code) === token || (!!optionLabels?.[code] && conceptFieldToken(optionLabels[code]) === token))) return null
  const meaning = conceptValueCode(concept, value)
  if (!meaning) return null
  const matches = [...new Set(options)].filter(code => [code, optionLabels?.[code]].some(name => !!name && conceptValueCode(concept, name) === meaning))
  return matches.length === 1 ? matches[0] : null
}

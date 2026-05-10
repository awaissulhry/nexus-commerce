/**
 * Amazon Flat-File Spreadsheet Service
 *
 * Generates a column manifest that mirrors Amazon's official flat-file
 * template structure (as downloaded from Seller Central), including:
 *   - Exact Amazon group order in the marketplace's local language
 *   - Schema-driven column labels (extracted from Amazon's localized
 *     JSON Schema titles — automatically market-specific)
 *   - Static fallback labels for fixed infrastructure columns
 *   - Schema-driven valid values (enum options) per field
 *   - TSV export + JSON feed body generation
 */

import type { PrismaClient } from '@nexus/database'
import { CategorySchemaService } from '../categories/schema-sync.service.js'

// ── Constants ──────────────────────────────────────────────────────────

export const MARKETPLACE_ID_MAP: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

export const LANGUAGE_TAG_MAP: Record<string, string> = {
  IT: 'it_IT',
  DE: 'de_DE',
  FR: 'fr_FR',
  ES: 'es_ES',
  UK: 'en_GB',
}

export const CURRENCY_MAP: Record<string, string> = {
  IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP',
}

// ── Types ──────────────────────────────────────────────────────────────

export type FlatFileColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean'

export interface FlatFileColumn {
  id: string          // Internal field ID used as the row key
  fieldRef: string    // Amazon flat-file attribute reference
  labelEn: string     // English label
  labelLocal: string  // Marketplace-local label (from Amazon schema title)
  description?: string
  required: boolean
  kind: FlatFileColumnKind
  options?: string[]  // Valid values / enum choices
  maxLength?: number
  width: number
}

export interface FlatFileColumnGroup {
  id: string
  labelEn: string     // English group name
  labelLocal: string  // Marketplace-local group name
  color: string       // Tailwind colour prefix
  columns: FlatFileColumn[]
}

export interface FlatFileManifest {
  marketplace: string
  productType: string
  variationThemes: string[]
  fetchedAt: string
  groups: FlatFileColumnGroup[]
}

export interface FlatFileRow {
  _rowId: string
  _isNew?: boolean
  _productId?: string
  _dirty?: boolean
  _status?: 'idle' | 'pending' | 'success' | 'error'
  _feedMessage?: string
  [key: string]: unknown
}

// ── Market-local labels for infrastructure columns ─────────────────────
// These columns are structural (not product-type schema fields) so Amazon's
// schema titles won't cover them. We maintain per-language translations here.
// Schema-derived fields (item_name, brand, bullet_point, etc.) get their
// localised titles extracted directly from the live schema response instead.

type LangTag = 'it_IT' | 'de_DE' | 'fr_FR' | 'es_ES' | 'en_GB'

const FIXED_FIELD_LABELS: Record<string, Partial<Record<LangTag, string>>> = {
  item_sku:              { it_IT: 'SKU', de_DE: 'SKU', fr_FR: 'SKU', es_ES: 'SKU', en_GB: 'SKU' },
  product_type:          { it_IT: 'Tipo di prodotto', de_DE: 'Produkttyp', fr_FR: 'Type de produit', es_ES: 'Tipo de producto', en_GB: 'Product Type' },
  record_action:         { it_IT: "Azione sull'offerta", de_DE: 'Angebotsaktion', fr_FR: "Action sur l'offre", es_ES: 'Acción de la oferta', en_GB: 'Offer Action' },
  parentage_level:       { it_IT: 'Livello di parentela', de_DE: 'Hierarchieebene', fr_FR: 'Niveau de parenté', es_ES: 'Nivel de parentesco', en_GB: 'Parentage Level' },
  parent_sku:            { it_IT: 'SKU articolo Parent', de_DE: 'Übergeordnete SKU', fr_FR: 'SKU parent', es_ES: 'SKU del padre', en_GB: 'Parent SKU' },
  variation_theme:       { it_IT: 'Variazione Tema', de_DE: 'Variationsthema', fr_FR: 'Thème de variation', es_ES: 'Tema de variación', en_GB: 'Variation Theme' },
  external_product_id_type: { it_IT: 'Tipo ID prodotto', de_DE: 'Produktkennungstyp', fr_FR: "Type d'ID produit", es_ES: 'Tipo de ID de producto', en_GB: 'Product ID Type' },
  external_product_id:   { it_IT: 'ID prodotto', de_DE: 'Produktkennzeichen', fr_FR: 'ID produit', es_ES: 'ID de producto', en_GB: 'Product ID' },
  browse_node_1:         { it_IT: 'Nodi di navigazione 1', de_DE: 'Browseknoten 1', fr_FR: 'Nœud de navigation 1', es_ES: 'Nodo de navegación 1', en_GB: 'Browse Node 1' },
  browse_node_2:         { it_IT: 'Nodi di navigazione 2', de_DE: 'Browseknoten 2', fr_FR: 'Nœud de navigation 2', es_ES: 'Nodo de navegación 2', en_GB: 'Browse Node 2' },
  main_image_url:        { it_IT: 'URL immagine principale', de_DE: 'Haupt-Bild-URL', fr_FR: 'URL image principale', es_ES: 'URL imagen principal', en_GB: 'Main Image URL' },
  other_image_url_1:     { it_IT: 'URL altra immagine', de_DE: 'Weitere Bild-URL', fr_FR: 'URL autre image', es_ES: 'URL otra imagen', en_GB: 'Other Image URL' },
  other_image_url_2:     { it_IT: 'URL altra immagine', de_DE: 'Weitere Bild-URL', fr_FR: 'URL autre image', es_ES: 'URL otra imagen', en_GB: 'Other Image URL' },
  other_image_url_3:     { it_IT: 'URL altra immagine', de_DE: 'Weitere Bild-URL', fr_FR: 'URL autre image', es_ES: 'URL otra imagen', en_GB: 'Other Image URL' },
  other_image_url_4:     { it_IT: 'URL altra immagine', de_DE: 'Weitere Bild-URL', fr_FR: 'URL autre image', es_ES: 'URL otra imagen', en_GB: 'Other Image URL' },
  other_image_url_5:     { it_IT: 'URL altra immagine', de_DE: 'Weitere Bild-URL', fr_FR: 'URL autre image', es_ES: 'URL otra imagen', en_GB: 'Other Image URL' },
  swatch_image_url:      { it_IT: 'URL immagine campione', de_DE: 'Muster-Bild-URL', fr_FR: "URL image d'échantillon", es_ES: 'URL imagen de muestra', en_GB: 'Swatch Image URL' },
  skip_offer:            { it_IT: "Ignora l'offerta", de_DE: 'Angebot überspringen', fr_FR: "Ignorer l'offre", es_ES: 'Omitir oferta', en_GB: 'Skip Offer' },
  condition_type:        { it_IT: "Condizione dell'articolo", de_DE: 'Artikelzustand', fr_FR: "État de l'article", es_ES: 'Condición del artículo', en_GB: 'Item Condition' },
  condition_note:        { it_IT: 'Nota sulle condizioni', de_DE: 'Zustandshinweis', fr_FR: 'Note sur les conditions', es_ES: 'Nota sobre condición', en_GB: 'Condition Note' },
  list_price:            { it_IT: 'Prezzo al pubblico consigliato (IVA inclusa)', de_DE: 'Unverbindlicher Verkaufspreis (inkl. MwSt.)', fr_FR: 'Prix public conseillé (TVA incluse)', es_ES: 'Precio de venta recomendado (IVA incl.)', en_GB: 'List Price (incl. VAT)' },
  product_tax_code:      { it_IT: 'Codice fiscale del prodotto', de_DE: 'Steuerklasse', fr_FR: 'Code fiscal produit', es_ES: 'Código fiscal del producto', en_GB: 'Product Tax Code' },
  merchant_release_date: { it_IT: 'Data di uscita', de_DE: 'Erscheinungsdatum', fr_FR: 'Date de sortie', es_ES: 'Fecha de lanzamiento', en_GB: 'Release Date' },
  max_order_quantity:    { it_IT: 'Quantitativo massimo ordine', de_DE: 'Max. Bestellmenge', fr_FR: 'Quantité max. par commande', es_ES: 'Cantidad máxima de pedido', en_GB: 'Max Order Quantity' },
  fulfillment_channel_code: { it_IT: 'Codice canale di gestione', de_DE: 'Versandkanal-Code', fr_FR: "Code canal d'expédition", es_ES: 'Código de canal de envío', en_GB: 'Fulfillment Channel Code' },
  quantity:              { it_IT: 'Quantità', de_DE: 'Menge', fr_FR: 'Quantité', es_ES: 'Cantidad', en_GB: 'Quantity' },
  lead_time_to_ship:     { it_IT: 'Tempo di gestione', de_DE: 'Bearbeitungszeit', fr_FR: 'Délai de traitement', es_ES: 'Tiempo de preparación', en_GB: 'Handling Days' },
  price_eur:             { it_IT: 'Prezzo (Vendita su Amazon)', de_DE: 'Preis (Verkauf auf Amazon)', fr_FR: 'Prix (Vente sur Amazon)', es_ES: 'Precio (Venta en Amazon)', en_GB: 'Price (Selling on Amazon)' },
  sale_price:            { it_IT: 'Prezzo di vendita', de_DE: 'Aktionspreis', fr_FR: 'Prix de vente', es_ES: 'Precio de oferta', en_GB: 'Sale Price' },
  sale_start_date:       { it_IT: 'Data inizio vendita', de_DE: 'Aktionsbeginn', fr_FR: 'Début de la vente', es_ES: 'Inicio de oferta', en_GB: 'Sale Start Date' },
  sale_end_date:         { it_IT: 'Data fine vendita', de_DE: 'Aktionsende', fr_FR: 'Fin de la vente', es_ES: 'Fin de oferta', en_GB: 'Sale End Date' },
  min_price:             { it_IT: 'Prezzo minimo consentito', de_DE: 'Mindestverkaufspreis', fr_FR: 'Prix minimum autorisé', es_ES: 'Precio mínimo permitido', en_GB: 'Minimum Seller Allowed Price' },
  max_price:             { it_IT: 'Prezzo massimo consentito', de_DE: 'Höchstverkaufspreis', fr_FR: 'Prix maximum autorisé', es_ES: 'Precio máximo permitido', en_GB: 'Maximum Seller Allowed Price' },
  merchant_shipping_group: { it_IT: 'Modello di spedizione', de_DE: 'Versandvorlage', fr_FR: "Modèle d'expédition", es_ES: 'Plantilla de envío', en_GB: 'Shipping Template' },
  pkg_length:            { it_IT: 'Lunghezza imballaggio', de_DE: 'Verpackungslänge', fr_FR: 'Longueur emballage', es_ES: 'Longitud del embalaje', en_GB: 'Package Length' },
  pkg_length_unit:       { it_IT: 'Unità lunghezza', de_DE: 'Längeneinheit', fr_FR: 'Unité de longueur', es_ES: 'Unidad de longitud', en_GB: 'Length Unit' },
  pkg_width:             { it_IT: 'Larghezza imballaggio', de_DE: 'Verpackungsbreite', fr_FR: 'Largeur emballage', es_ES: 'Anchura del embalaje', en_GB: 'Package Width' },
  pkg_width_unit:        { it_IT: 'Unità larghezza', de_DE: 'Breiteneinheit', fr_FR: 'Unité de largeur', es_ES: 'Unidad de anchura', en_GB: 'Width Unit' },
  pkg_height:            { it_IT: 'Altezza imballaggio', de_DE: 'Verpackungshöhe', fr_FR: 'Hauteur emballage', es_ES: 'Altura del embalaje', en_GB: 'Package Height' },
  pkg_height_unit:       { it_IT: 'Unità altezza', de_DE: 'Höheneinheit', fr_FR: "Unité de hauteur", es_ES: 'Unidad de altura', en_GB: 'Height Unit' },
  pkg_weight:            { it_IT: 'Peso imballaggio', de_DE: 'Verpackungsgewicht', fr_FR: 'Poids emballage', es_ES: 'Peso del embalaje', en_GB: 'Package Weight' },
  pkg_weight_unit:       { it_IT: 'Unità peso', de_DE: 'Gewichtseinheit', fr_FR: 'Unité de poids', es_ES: 'Unidad de peso', en_GB: 'Weight Unit' },
  country_of_origin:     { it_IT: 'Paese di origine', de_DE: 'Herkunftsland', fr_FR: "Pays d'origine", es_ES: 'País de origen', en_GB: 'Country of Origin' },
  batteries_required:    { it_IT: 'Le batterie sono necessarie?', de_DE: 'Batterien erforderlich?', fr_FR: 'Batteries requises ?', es_ES: '¿Se requieren baterías?', en_GB: 'Batteries Required?' },
  batteries_included:    { it_IT: 'Le batterie sono incluse?', de_DE: 'Batterien enthalten?', fr_FR: 'Batteries incluses ?', es_ES: '¿Baterías incluidas?', en_GB: 'Batteries Included?' },
  item_weight:           { it_IT: "Peso dell'articolo", de_DE: 'Artikelgewicht', fr_FR: "Poids de l'article", es_ES: 'Peso del artículo', en_GB: 'Item Weight' },
  item_weight_unit:      { it_IT: 'Unità peso articolo', de_DE: 'Gewichtseinheit', fr_FR: 'Unité de poids', es_ES: 'Unidad de peso', en_GB: 'Weight Unit' },
}

// Group names per language
const GROUP_LOCAL_LABELS: Record<string, Partial<Record<LangTag, string>>> = {
  offer_identity:    { it_IT: "Identità dell'offerta", de_DE: 'Angebotsidentität', fr_FR: "Identité de l'offre", es_ES: 'Identidad de la oferta', en_GB: 'Offer Identity' },
  variations:        { it_IT: 'Variazioni', de_DE: 'Variationen', fr_FR: 'Variations', es_ES: 'Variaciones', en_GB: 'Variations' },
  product_identity:  { it_IT: 'Identità prodotto', de_DE: 'Produktidentität', fr_FR: 'Identité du produit', es_ES: 'Identidad del producto', en_GB: 'Product Identity' },
  images:            { it_IT: 'Immagini', de_DE: 'Bilder', fr_FR: 'Images', es_ES: 'Imágenes', en_GB: 'Images' },
  product_details:   { it_IT: 'Dettagli prodotto', de_DE: 'Produktdetails', fr_FR: 'Détails du produit', es_ES: 'Detalles del producto', en_GB: 'Product Details' },
  offer:             { it_IT: 'Offerta', de_DE: 'Angebot', fr_FR: 'Offre', es_ES: 'Oferta', en_GB: 'Offer' },
  offer_it:          { it_IT: 'Offerta (IT) - Vendita su Amazon', de_DE: 'Angebot (DE) - Verkauf bei Amazon', fr_FR: 'Offre (FR) - Vente sur Amazon', es_ES: 'Oferta (ES) - Venta en Amazon', en_GB: 'Offer (UK) - Selling on Amazon' },
  shipping:          { it_IT: 'Spedizione', de_DE: 'Versand', fr_FR: 'Expédition', es_ES: 'Envío', en_GB: 'Shipping' },
  compliance:        { it_IT: 'Conformità e sicurezza', de_DE: 'Konformität und Sicherheit', fr_FR: 'Conformité et sécurité', es_ES: 'Conformidad y seguridad', en_GB: 'Compliance & Safety' },
  other_attributes:  { it_IT: 'Altri attributi', de_DE: 'Weitere Attribute', fr_FR: 'Autres attributs', es_ES: 'Otros atributos', en_GB: 'Other Attributes' },
}

/** Resolve a label: schema title > fixed translation > English fallback */
function resolveLabel(id: string, langTag: LangTag, schemaLabels: Record<string, string>, fallbackEn: string): string {
  return schemaLabels[id] ?? FIXED_FIELD_LABELS[id]?.[langTag] ?? fallbackEn
}

/** Extract localised titles from schema properties into a flat map. */
function buildSchemaLabels(properties: Record<string, any>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [fieldId, prop] of Object.entries(properties)) {
    const title: string | undefined = prop?.title ?? prop?.items?.properties?.value?.title
    if (title) map[fieldId] = title
  }
  return map
}

// ── Fixed group definitions (Amazon's exact structure) ─────────────────
// All accept (lang, sl) — langTag for translations, sl = schema label map

type LL = (id: string, fallbackEn: string) => string  // local-label resolver

function offerIdentityGroup(variationThemes: string[], ll: LL, lang: LangTag, marketplace: string): FlatFileColumnGroup {
  return {
    id: 'offer_identity',
    labelEn: 'Offer Identity',
    labelLocal: GROUP_LOCAL_LABELS.offer_identity[lang] ?? "Offer Identity",
    color: 'blue',
    columns: [
      { id: 'item_sku',      fieldRef: 'contribution_sku#1.value',  labelEn: 'Seller SKU',   labelLocal: ll('item_sku', 'SKU'),          required: true,  kind: 'text',   width: 180 },
      { id: 'product_type',  fieldRef: 'product_type#1.value',       labelEn: 'Product Type', labelLocal: ll('product_type', 'Product Type'), required: true, kind: 'text', width: 140 },
      { id: 'record_action', fieldRef: '::record_action',            labelEn: 'Operation',    labelLocal: ll('record_action', 'Offer Action'), required: true, kind: 'enum', width: 130,
        options: ['full_update', 'partial_update', 'delete'],
        description: 'full_update = create or replace; partial_update = merge fields; delete = remove' },
    ],
  }
}

function variationsGroup(variationThemes: string[], ll: LL, lang: LangTag): FlatFileColumnGroup {
  return {
    id: 'variations',
    labelEn: 'Variations',
    labelLocal: GROUP_LOCAL_LABELS.variations[lang] ?? 'Variations',
    color: 'purple',
    columns: [
      { id: 'parentage_level', fieldRef: 'parentage_level[marketplace_id]#1.value', labelEn: 'Parent/Child', labelLocal: ll('parentage_level', 'Parentage Level'), required: false, kind: 'enum', width: 110,
        options: ['', 'parent', 'child'], description: 'Leave blank for standalone. "parent" = non-buyable variation parent. "child" = variant.' },
      { id: 'parent_sku', fieldRef: 'child_parent_sku_relationship[marketplace_id]#1.parent_sku', labelEn: 'Parent SKU', labelLocal: ll('parent_sku', 'Parent SKU'), required: false, kind: 'text', width: 170,
        description: 'Required when parentage_level = child' },
      { id: 'variation_theme', fieldRef: 'variation_theme#1.name', labelEn: 'Variation Theme', labelLocal: ll('variation_theme', 'Variation Theme'), required: false, kind: 'enum', width: 170,
        options: ['', ...variationThemes],
        description: 'Required on parent rows.' },
    ],
  }
}

function productIdentityGroup(schemaEnums: Record<string, string[]>, ll: LL, lang: LangTag): FlatFileColumnGroup {
  return {
    id: 'product_identity',
    labelEn: 'Product Identity',
    labelLocal: GROUP_LOCAL_LABELS.product_identity[lang] ?? 'Product Identity',
    color: 'emerald',
    columns: [
      { id: 'item_name',      fieldRef: 'item_name[marketplace_id][language_tag]#1.value', labelEn: 'Title',         labelLocal: ll('item_name', 'Title'), required: true, kind: 'text', width: 300, maxLength: 200 },
      { id: 'brand',          fieldRef: 'brand[marketplace_id][language_tag]#1.value',     labelEn: 'Brand',         labelLocal: ll('brand', 'Brand'),     required: true, kind: 'text', width: 140 },
      { id: 'external_product_id_type', fieldRef: 'amzn1.volt.ca.product_id_type', labelEn: 'ID Type', labelLocal: ll('external_product_id_type', 'Product ID Type'), required: false, kind: 'enum', width: 90, options: ['', 'EAN', 'UPC', 'GTIN', 'ISBN', 'ASIN'] },
      { id: 'external_product_id',      fieldRef: 'amzn1.volt.ca.product_id_value', labelEn: 'EAN / UPC / GTIN', labelLocal: ll('external_product_id', 'Product ID'), required: false, kind: 'text', width: 160 },
      { id: 'browse_node_1',  fieldRef: 'recommended_browse_nodes[marketplace_id]#1.value', labelEn: 'Browse Node 1', labelLocal: ll('browse_node_1', 'Browse Node 1'), required: false, kind: 'text', width: 150 },
      { id: 'browse_node_2',  fieldRef: 'recommended_browse_nodes[marketplace_id]#2.value', labelEn: 'Browse Node 2', labelLocal: ll('browse_node_2', 'Browse Node 2'), required: false, kind: 'text', width: 150 },
      { id: 'model_number',   fieldRef: 'model_number[marketplace_id]#1.value', labelEn: 'Model Number', labelLocal: ll('model_number', 'Model Number'), required: false, kind: 'text', width: 130 },
      { id: 'model_name',     fieldRef: 'model_name[marketplace_id][language_tag]#1.value', labelEn: 'Model Name', labelLocal: ll('model_name', 'Model Name'), required: false, kind: 'text', width: 150 },
      { id: 'manufacturer',   fieldRef: 'manufacturer[marketplace_id][language_tag]#1.value', labelEn: 'Manufacturer', labelLocal: ll('manufacturer', 'Manufacturer'), required: false, kind: 'text', width: 150 },
    ],
  }
}

function imagesGroup(ll: LL, lang: LangTag): FlatFileColumnGroup {
  const imgCol = (id: string, ref: string, labelEn: string): FlatFileColumn => ({
    id, fieldRef: ref, labelEn, labelLocal: ll(id, labelEn), required: false, kind: 'text', width: 220,
    description: 'Full HTTPS URL to image (min 1000px, white background)',
  })
  return {
    id: 'images',
    labelEn: 'Images',
    labelLocal: GROUP_LOCAL_LABELS.images[lang] ?? 'Images',
    color: 'orange',
    columns: [
      imgCol('main_image_url',   'main_product_image_locator[marketplace_id]#1.media_location', 'Main Image URL'),
      imgCol('other_image_url_1','other_product_image_locator_1[marketplace_id]#1.media_location', 'Image 2 URL'),
      imgCol('other_image_url_2','other_product_image_locator_2[marketplace_id]#1.media_location', 'Image 3 URL'),
      imgCol('other_image_url_3','other_product_image_locator_3[marketplace_id]#1.media_location', 'Image 4 URL'),
      imgCol('other_image_url_4','other_product_image_locator_4[marketplace_id]#1.media_location', 'Image 5 URL'),
      imgCol('other_image_url_5','other_product_image_locator_5[marketplace_id]#1.media_location', 'Image 6 URL'),
      imgCol('swatch_image_url', 'swatch_product_image_locator[marketplace_id]#1.media_location', 'Swatch Image URL'),
    ],
  }
}

function productDetailsGroup(schemaEnums: Record<string, string[]>, ll: LL, lang: LangTag): FlatFileColumnGroup {
  function col(id: string, ref: string, labelEn: string, overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return { id, fieldRef: ref, labelEn, labelLocal: ll(id, labelEn), required: false, kind: 'text', width: 160, ...overrides }
  }
  function enumCol(id: string, ref: string, labelEn: string, options: string[], overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return col(id, ref, labelEn, { kind: 'enum', options: ['', ...options.filter(Boolean)], width: 150, ...overrides })
  }
  return {
    id: 'product_details',
    labelEn: 'Product Details',
    labelLocal: GROUP_LOCAL_LABELS.product_details[lang] ?? 'Product Details',
    color: 'teal',
    columns: [
      col('product_description','product_description[marketplace_id][language_tag]#1.value','Description', { kind: 'longtext', width: 280 }),
      col('bullet_point1','bullet_point[marketplace_id][language_tag]#1.value','Bullet Point 1', { width: 220, maxLength: 255 }),
      col('bullet_point2','bullet_point[marketplace_id][language_tag]#2.value','Bullet Point 2', { width: 220, maxLength: 255 }),
      col('bullet_point3','bullet_point[marketplace_id][language_tag]#3.value','Bullet Point 3', { width: 220, maxLength: 255 }),
      col('bullet_point4','bullet_point[marketplace_id][language_tag]#4.value','Bullet Point 4', { width: 220, maxLength: 255 }),
      col('bullet_point5','bullet_point[marketplace_id][language_tag]#5.value','Bullet Point 5', { width: 220, maxLength: 255 }),
      col('generic_keyword','generic_keyword[marketplace_id][language_tag]#1.value','Search Terms', { width: 220, maxLength: 250 }),
      col('special_feature1','special_feature[marketplace_id][language_tag]#1.value','Special Feature 1', { width: 180 }),
      col('special_feature2','special_feature[marketplace_id][language_tag]#2.value','Special Feature 2', { width: 180 }),
      col('special_feature3','special_feature[marketplace_id][language_tag]#3.value','Special Feature 3', { width: 180 }),
      enumCol('lifestyle','lifestyle[marketplace_id][language_tag]#1.value','Lifestyle', schemaEnums['lifestyle'] ?? []),
      enumCol('style','style[marketplace_id][language_tag]#1.value','Style', schemaEnums['style'] ?? []),
      col('department','department[marketplace_id][language_tag]#1.value','Target Audience', { width: 180 }),
      enumCol('target_gender','target_gender[marketplace_id]#1.value','Target Gender', schemaEnums['target_gender'] ?? ['male','female','unisex'], { width: 120 }),
      col('age_range_description','age_range_description[marketplace_id][language_tag]#1.value','Age Range', { width: 130 }),
      enumCol('apparel_size_system','apparel_size[marketplace_id]#1.size_system','Size System', schemaEnums['apparel_size.size_system'] ?? ['IT','FR','DE','UK','US','JP'], { width: 120 }),
      enumCol('apparel_size_class','apparel_size[marketplace_id]#1.size_class','Size Format', schemaEnums['apparel_size.size_class'] ?? [], { width: 130 }),
      col('apparel_size','apparel_size[marketplace_id]#1.size','Size', { width: 100 }),
      col('apparel_size_to','apparel_size[marketplace_id]#1.size_to','Size To', { width: 90 }),
      enumCol('apparel_body_type','apparel_size[marketplace_id]#1.body_type','Body Type', schemaEnums['apparel_size.body_type'] ?? ['Regular','Plus','Petite'], { width: 110 }),
      col('material1','material[marketplace_id][language_tag]#1.value','Material 1', { width: 140 }),
      col('material2','material[marketplace_id][language_tag]#2.value','Material 2', { width: 140 }),
      col('material3','material[marketplace_id][language_tag]#3.value','Material 3', { width: 140 }),
      col('fabric_type','fabric_type[marketplace_id][language_tag]#1.value','Fabric Type', { width: 150 }),
      col('lining_description','lining_description[marketplace_id][language_tag]#1.value','Lining', { width: 150 }),
      col('color_map','color[marketplace_id][language_tag]#1.standardized_values#1','Color Map', { width: 120 }),
      col('color','color[marketplace_id][language_tag]#1.value','Color', { width: 130 }),
      enumCol('fit_type','fit_type[marketplace_id][language_tag]#1.value','Fit Type', schemaEnums['fit_type'] ?? [], { width: 130 }),
      col('pattern','pattern[marketplace_id][language_tag]#1.value','Pattern', { width: 130 }),
      col('care_instructions','care_instructions[marketplace_id][language_tag]#1.value','Care Instructions', { width: 200 }),
      col('item_type_name','item_type_name[marketplace_id][language_tag]#1.value','Product Type Name', { width: 160 }),
      enumCol('water_resistance_level','water_resistance_level[marketplace_id]#1.value','Water Resistance', schemaEnums['water_resistance_level'] ?? [], { width: 160 }),
      col('part_number','part_number[marketplace_id]#1.value','Part Number / MPN', { width: 140 }),
      col('number_of_items','number_of_items[marketplace_id]#1.value','Number of Items', { kind: 'number', width: 100 }),
    ],
  }
}

function offerGroup(schemaEnums: Record<string, string[]>, ll: LL, lang: LangTag): FlatFileColumnGroup {
  return {
    id: 'offer',
    labelEn: 'Offer',
    labelLocal: GROUP_LOCAL_LABELS.offer[lang] ?? 'Offer',
    color: 'amber',
    columns: [
      { id: 'skip_offer',   fieldRef: 'skip_offer[marketplace_id]#1.value',    labelEn: 'Skip Offer',    labelLocal: ll('skip_offer', 'Skip Offer'),       required: false, kind: 'enum',   width: 100, options: ['', 'true', 'false'] },
      { id: 'condition_type',fieldRef:'condition_type[marketplace_id]#1.value', labelEn: 'Condition',     labelLocal: ll('condition_type', 'Condition'),     required: false, kind: 'enum',   width: 120, options: ['', 'new_new', ...(schemaEnums['condition_type'] ?? ['new_new'])] },
      { id: 'condition_note',fieldRef:'condition_note[marketplace_id][language_tag]#1.value', labelEn: 'Condition Note', labelLocal: ll('condition_note', 'Condition Note'), required: false, kind: 'text', width: 180 },
      { id: 'list_price',   fieldRef: 'list_price[marketplace_id]#1.value_with_tax', labelEn: 'RRP (incl. VAT)', labelLocal: ll('list_price', 'RRP (incl. VAT)'), required: false, kind: 'number', width: 120 },
      { id: 'product_tax_code', fieldRef: 'product_tax_code#1.value', labelEn: 'Tax Code', labelLocal: ll('product_tax_code', 'Tax Code'), required: false, kind: 'text', width: 110 },
      { id: 'merchant_release_date', fieldRef: 'merchant_release_date[marketplace_id]#1.value', labelEn: 'Release Date', labelLocal: ll('merchant_release_date', 'Release Date'), required: false, kind: 'text', width: 120 },
      { id: 'max_order_quantity', fieldRef: 'max_order_quantity[marketplace_id]#1.value', labelEn: 'Max Order Qty', labelLocal: ll('max_order_quantity', 'Max Order Qty'), required: false, kind: 'number', width: 110 },
    ],
  }
}

function offerMarketGroup(defaultCurrency: string, mp: string, ll: LL, lang: LangTag): FlatFileColumnGroup {
  return {
    id: 'offer_it',
    labelEn: `Offer (${mp}) — Amazon`,
    labelLocal: GROUP_LOCAL_LABELS.offer_it[lang] ?? `Offer (${mp}) — Amazon`,
    color: 'yellow',
    columns: [
      { id: 'fulfillment_channel_code', fieldRef: 'fulfillment_availability#1.fulfillment_channel_code', labelEn: 'Fulfillment Channel', labelLocal: ll('fulfillment_channel_code', 'Fulfillment Channel'), required: false, kind: 'enum', width: 150, options: ['', 'DEFAULT', 'AMAZON_EU'] },
      { id: 'quantity',         fieldRef: 'fulfillment_availability#1.quantity',    labelEn: 'Quantity',     labelLocal: ll('quantity', 'Quantity'),       required: false, kind: 'number', width: 80 },
      { id: 'lead_time_to_ship',fieldRef: 'fulfillment_availability#1.lead_time_to_ship_max_days', labelEn: 'Handling Days', labelLocal: ll('lead_time_to_ship', 'Handling Days'), required: false, kind: 'number', width: 110 },
      { id: 'price_eur',        fieldRef: `purchasable_offer[marketplace_id][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`, labelEn: `Price ${defaultCurrency} (incl. VAT)`, labelLocal: ll('price_eur', `Price ${defaultCurrency} (incl. VAT)`), required: false, kind: 'number', width: 130 },
      { id: 'sale_price',       fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.value_with_tax', labelEn: 'Sale Price', labelLocal: ll('sale_price', 'Sale Price'), required: false, kind: 'number', width: 110 },
      { id: 'sale_start_date',  fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.start_at', labelEn: 'Sale Start', labelLocal: ll('sale_start_date', 'Sale Start'), required: false, kind: 'text', width: 120 },
      { id: 'sale_end_date',    fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.end_at', labelEn: 'Sale End', labelLocal: ll('sale_end_date', 'Sale End'), required: false, kind: 'text', width: 120 },
      { id: 'min_price',        fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax', labelEn: 'Min Price', labelLocal: ll('min_price', 'Min Price'), required: false, kind: 'number', width: 100 },
      { id: 'max_price',        fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.maximum_seller_allowed_price#1.schedule#1.value_with_tax', labelEn: 'Max Price', labelLocal: ll('max_price', 'Max Price'), required: false, kind: 'number', width: 100 },
      { id: 'merchant_shipping_group', fieldRef: 'merchant_shipping_group[marketplace_id]#1.value', labelEn: 'Shipping Template', labelLocal: ll('merchant_shipping_group', 'Shipping Template'), required: false, kind: 'text', width: 160 },
    ],
  }
}

function shippingGroup(ll: LL, lang: LangTag): FlatFileColumnGroup {
  function dimCol(id: string, ref: string, labelEn: string, isUnit = false): FlatFileColumn {
    return {
      id, fieldRef: ref, labelEn, labelLocal: ll(id, labelEn),
      required: false, kind: isUnit ? 'enum' : 'number', width: isUnit ? 100 : 90,
      options: isUnit ? ['', 'centimeters', 'meters', 'inches', 'millimeters'] : undefined,
    }
  }
  return {
    id: 'shipping',
    labelEn: 'Shipping',
    labelLocal: GROUP_LOCAL_LABELS.shipping[lang] ?? 'Shipping',
    color: 'sky',
    columns: [
      dimCol('pkg_length',      'item_package_dimensions[marketplace_id]#1.length.value',  'Pkg Length'),
      dimCol('pkg_length_unit', 'item_package_dimensions[marketplace_id]#1.length.unit',   'Pkg Length Unit', true),
      dimCol('pkg_width',       'item_package_dimensions[marketplace_id]#1.width.value',   'Pkg Width'),
      dimCol('pkg_width_unit',  'item_package_dimensions[marketplace_id]#1.width.unit',    'Pkg Width Unit', true),
      dimCol('pkg_height',      'item_package_dimensions[marketplace_id]#1.height.value',  'Pkg Height'),
      dimCol('pkg_height_unit', 'item_package_dimensions[marketplace_id]#1.height.unit',   'Pkg Height Unit', true),
      dimCol('pkg_weight',      'item_package_weight[marketplace_id]#1.value',             'Pkg Weight'),
      { id: 'pkg_weight_unit', fieldRef: 'item_package_weight[marketplace_id]#1.unit', labelEn: 'Pkg Weight Unit', labelLocal: ll('pkg_weight_unit', 'Weight Unit'), required: false, kind: 'enum', width: 100, options: ['', 'grams', 'kilograms', 'pounds', 'ounces'] },
    ],
  }
}

function complianceGroup(schemaEnums: Record<string, string[]>, ll: LL, lang: LangTag): FlatFileColumnGroup {
  function col(id: string, ref: string, labelEn: string, overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return { id, fieldRef: ref, labelEn, labelLocal: ll(id, labelEn), required: false, kind: 'text', width: 150, ...overrides }
  }
  return {
    id: 'compliance',
    labelEn: 'Compliance & Safety',
    labelLocal: GROUP_LOCAL_LABELS.compliance[lang] ?? 'Compliance & Safety',
    color: 'red',
    columns: [
      col('country_of_origin', 'country_of_origin[marketplace_id]#1.value', 'Country of Origin', { kind: 'enum', width: 140, options: ['', 'IT', 'CN', 'DE', 'FR', 'ES', 'PT', 'IN', 'BD', 'TR', 'VN', 'PK', 'ID'] }),
      col('batteries_required','batteries_required[marketplace_id]#1.value','Batteries Required', { kind: 'enum', width: 140, options: ['', 'true', 'false'] }),
      col('batteries_included','batteries_included[marketplace_id]#1.value','Batteries Included', { kind: 'enum', width: 140, options: ['', 'true', 'false'] }),
      col('item_weight',       'item_weight[marketplace_id]#1.value',       'Item Weight',        { kind: 'number', width: 100 }),
      col('item_weight_unit',  'item_weight[marketplace_id]#1.unit',        'Item Weight Unit',   { kind: 'enum', width: 120, options: ['', 'grams', 'kilograms', 'pounds', 'ounces'] }),
    ],
  }
}

// ── Columns already in fixed groups (exclude from schema dynamic group) ─

const FIXED_FIELD_IDS = new Set([
  'item_sku','product_type','record_action',
  'parentage_level','parent_sku','variation_theme',
  'item_name','brand','external_product_id_type','external_product_id',
  'browse_node_1','browse_node_2','model_number','model_name','manufacturer',
  'main_image_url','other_image_url_1','other_image_url_2','other_image_url_3',
  'other_image_url_4','other_image_url_5','swatch_image_url',
  'product_description','bullet_point1','bullet_point2','bullet_point3','bullet_point4','bullet_point5',
  'generic_keyword','special_feature1','special_feature2','special_feature3',
  'lifestyle','style','department','target_gender','age_range_description',
  'apparel_size_system','apparel_size_class','apparel_size','apparel_size_to','apparel_body_type',
  'material1','material2','material3','fabric_type','lining_description',
  'color_map','color','fit_type','pattern','care_instructions','item_type_name',
  'water_resistance_level','part_number','number_of_items',
  'skip_offer','condition_type','condition_note','list_price','product_tax_code','merchant_release_date','max_order_quantity',
  'fulfillment_channel_code','quantity','lead_time_to_ship','price_eur','sale_price',
  'sale_start_date','sale_end_date','min_price','max_price','merchant_shipping_group',
  'pkg_length','pkg_length_unit','pkg_width','pkg_width_unit','pkg_height','pkg_height_unit','pkg_weight','pkg_weight_unit',
  'country_of_origin','batteries_required','batteries_included','item_weight','item_weight_unit',
])

// Also schema fields we handle via the fixed groups (to avoid duplication)
const SCHEMA_FIELDS_SKIP = new Set([
  'item_name','brand','product_description','bullet_point','generic_keyword',
  'special_feature','lifestyle','style','department','target_gender',
  'age_range_description','apparel_size','material','fabric_type','lining_description',
  'color','fit_type','pattern','care_instructions','item_type_name','water_resistance_level',
  'part_number','number_of_items','model_number','model_name','manufacturer',
  'skip_offer','condition_type','condition_note','list_price','product_tax_code',
  'merchant_release_date','max_order_quantity','country_of_origin','batteries_required',
  'batteries_included','item_weight','item_package_dimensions','item_package_weight',
  'recommended_browse_nodes','variation_theme','parentage_level','child_parent_sku_relationship',
  'purchasable_offer','fulfillment_availability','merchant_shipping_group',
])

// ── Schema property parser ─────────────────────────────────────────────

function extractEnumOptions(inner: Record<string, any>): string[] {
  const enums: string[] = inner?.enum ?? inner?.['x-amazon-attributes']?.validValues ?? []
  return enums.map(String)
}

function schemaFieldToColumn(
  fieldId: string,
  prop: Record<string, any>,
  isRequired: boolean,
  schemaLabels: Record<string, string>,
): FlatFileColumn | null {
  const inner = prop?.items?.properties?.value ?? prop
  const t = inner?.type
  let kind: FlatFileColumnKind = 'text'
  let options: string[] | undefined

  if (inner?.enum || inner?.['x-amazon-attributes']?.validValues) {
    kind = 'enum'
    options = extractEnumOptions(inner)
  } else if (t === 'number' || t === 'integer') {
    kind = 'number'
  } else if (t === 'boolean') {
    kind = 'enum'
    options = ['', 'true', 'false']
  } else if (t === 'string') {
    kind = (inner?.maxLength ?? 0) > 500 ? 'longtext' : 'text'
  } else {
    return null
  }

  const labelEn = fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  // labelLocal: prefer the schema's localized title (market-specific),
  // then the fixed-field fallback table, then fall back to English
  const labelLocal = schemaLabels[fieldId] ?? FIXED_FIELD_LABELS[fieldId]?.['it_IT'] ?? labelEn
  return {
    id: `attr_${fieldId}`,
    fieldRef: fieldId,
    labelEn,
    labelLocal,
    required: isRequired,
    kind,
    options,
    maxLength: typeof inner?.maxLength === 'number' ? inner.maxLength : undefined,
    width: kind === 'longtext' ? 240 : kind === 'enum' && (options?.length ?? 0) < 6 ? 130 : 160,
  }
}

// ── Main service ───────────────────────────────────────────────────────

export class AmazonFlatFileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly schemas: CategorySchemaService,
  ) {}

  async generateManifest(
    marketplace: string,
    productType: string,
    forceRefresh = false,
  ): Promise<FlatFileManifest> {
    const mp = marketplace.toUpperCase()
    const pt = productType.toUpperCase()

    const cached = forceRefresh
      ? await this.schemas.refreshSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
      : await this.schemas.getSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })

    const def = (cached.schemaDefinition ?? {}) as Record<string, any>
    const properties = (def.properties ?? {}) as Record<string, any>
    const requiredSet = new Set<string>(Array.isArray(def.required) ? def.required : [])

    const rawThemes = (cached.variationThemes as any)?.themes ?? []
    const variationThemes: string[] = Array.isArray(rawThemes) ? rawThemes.map(String) : []

    // Language tag for this marketplace
    const lang = (LANGUAGE_TAG_MAP[mp] ?? 'en_GB') as LangTag

    // Extract localised titles from the schema (Amazon provides these per marketplace)
    const schemaLabels = buildSchemaLabels(properties)

    // Build a local-label resolver: schema title > fixed translation > English fallback
    const ll: LL = (id, fallbackEn) => resolveLabel(id, lang, schemaLabels, fallbackEn)

    // Extract enum options for fields we reference in fixed groups
    const schemaEnums: Record<string, string[]> = {}
    for (const [fieldId, prop] of Object.entries(properties)) {
      const inner = (prop as any)?.items?.properties?.value ?? prop
      const opts = extractEnumOptions(inner as Record<string, any>)
      if (opts.length > 0) schemaEnums[fieldId] = opts
    }

    // Schema-dynamic group: fields not already in fixed groups
    const dynamicCols: FlatFileColumn[] = []
    for (const [fieldId, prop] of Object.entries(properties)) {
      if (SCHEMA_FIELDS_SKIP.has(fieldId)) continue
      const col = schemaFieldToColumn(fieldId, prop as Record<string, any>, requiredSet.has(fieldId), schemaLabels)
      if (col) dynamicCols.push(col)
    }
    dynamicCols.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      return a.labelEn.localeCompare(b.labelEn)
    })

    const currency = CURRENCY_MAP[mp] ?? 'EUR'

    const groups: FlatFileColumnGroup[] = [
      offerIdentityGroup(variationThemes, ll, lang, mp),
      variationsGroup(variationThemes, ll, lang),
      productIdentityGroup(schemaEnums, ll, lang),
      imagesGroup(ll, lang),
      productDetailsGroup(schemaEnums, ll, lang),
      offerGroup(schemaEnums, ll, lang),
      offerMarketGroup(currency, mp, ll, lang),
      shippingGroup(ll, lang),
      complianceGroup(schemaEnums, ll, lang),
    ]

    if (dynamicCols.length > 0) {
      groups.push({
        id: 'other_attributes',
        labelEn: 'Other Attributes',
        labelLocal: GROUP_LOCAL_LABELS.other_attributes[lang] ?? 'Other Attributes',
        color: 'violet',
        columns: dynamicCols,
      })
    }

    return { marketplace: mp, productType: pt, variationThemes, fetchedAt: new Date().toISOString(), groups }
  }

  async getExistingRows(
    marketplace: string,
    productType?: string,
    productId?: string,
  ): Promise<FlatFileRow[]> {
    const mp = marketplace.toUpperCase()
    let products: any[]

    if (productId) {
      // Load the anchor product to determine family scope
      const anchor = await this.prisma.product.findUnique({
        where: { id: productId },
        include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
      })
      if (!anchor) return []

      if (anchor.isParent) {
        // Parent: load itself + all children
        const children = await this.prisma.product.findMany({
          where: { parentId: productId, deletedAt: null },
          include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
          orderBy: { sku: 'asc' },
        })
        products = [anchor, ...children]
      } else if ((anchor as any).parentId) {
        // Child: load the parent + all siblings (including self)
        const parentId = (anchor as any).parentId as string
        const [parent, siblings] = await Promise.all([
          this.prisma.product.findUnique({
            where: { id: parentId },
            include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
          }),
          this.prisma.product.findMany({
            where: { parentId, deletedAt: null },
            include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
            orderBy: { sku: 'asc' },
          }),
        ])
        products = parent ? [parent, ...siblings] : siblings
      } else {
        // Standalone
        products = [anchor]
      }
    } else {
      const where: Record<string, any> = { deletedAt: null }
      if (productType) where.productType = productType.toUpperCase()
      products = await this.prisma.product.findMany({
        where,
        include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
        take: 2000,
      })
    }

    const currency = CURRENCY_MAP[mp] ?? 'EUR'
    return products.map((p) => {
      const listing = (p.channelListings as any[])[0]
      const attrs = ((listing?.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
      const bullets: string[] = Array.isArray(listing?.bulletPointsOverride)
        ? listing.bulletPointsOverride
        : Array.isArray(attrs.bullet_point)
        ? (attrs.bullet_point as any[]).map((b: any) => b?.value ?? String(b))
        : []

      const row: FlatFileRow = {
        _rowId: p.id, _productId: p.id, _isNew: false, _status: 'idle',
        item_sku: p.sku,
        product_type: (p.productType as string | null) ?? productType ?? '',
        record_action: 'full_update',
        parentage_level: p.isParent ? 'parent' : p.parentId ? 'child' : '',
        parent_sku: (p as any).parentAsin ?? '',
        variation_theme: String(attrs.variation_theme?.[0]?.value ?? ''),
        item_name: listing?.title ?? attrs.item_name?.[0]?.value ?? p.name,
        brand: String(attrs.brand?.[0]?.value ?? ''),
        external_product_id_type: (p as any).ean ? 'EAN' : (p as any).gtin ? 'GTIN' : '',
        external_product_id: (p as any).ean ?? (p as any).gtin ?? '',
        product_description: listing?.description ?? attrs.product_description?.[0]?.value ?? '',
        bullet_point1: bullets[0] ?? '', bullet_point2: bullets[1] ?? '',
        bullet_point3: bullets[2] ?? '', bullet_point4: bullets[3] ?? '',
        bullet_point5: bullets[4] ?? '',
        generic_keyword: String(attrs.generic_keyword?.[0]?.value ?? ''),
        color: String(attrs.color?.[0]?.value ?? ''),
        price_eur: listing?.price != null ? String(listing.price) : '',
        quantity: listing?.quantity != null ? String(listing.quantity) : '',
        fulfillment_channel_code: 'DEFAULT',
        main_image_url: '',
        skip_offer: 'false',
      }

      for (const [k, v] of Object.entries(attrs)) {
        if (SCHEMA_FIELDS_SKIP.has(k) || k in row) continue
        const val = Array.isArray(v) ? (v[0]?.value ?? '') : v
        row[`attr_${k}`] = val != null ? String(val) : ''
      }
      return row
    })
  }

  buildJsonFeedBody(rows: FlatFileRow[], marketplace: string, sellerId: string): string {
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const languageTag = LANGUAGE_TAG_MAP[mp] ?? 'it_IT'

    const messages = rows
      .filter((r) => r.item_sku)
      .map((row, i) => {
        const opRaw = String(row.record_action ?? 'full_update')
        const operationType = opRaw === 'delete' ? 'DELETE' : 'UPDATE'
        const productType = String(row.product_type ?? '').toUpperCase()
        if (operationType === 'DELETE') {
          return { messageId: i + 1, sku: String(row.item_sku), operationType, productType, attributes: {} }
        }
        const attrs: Record<string, any> = {}
        const wrap  = (v: string) => [{ value: v, marketplace_id: marketplaceId }]
        const wrapL = (v: string) => [{ value: v, language_tag: languageTag, marketplace_id: marketplaceId }]

        if (row.item_name)          attrs.item_name           = wrapL(String(row.item_name))
        if (row.brand)              attrs.brand               = wrapL(String(row.brand))
        if (row.product_description) attrs.product_description = wrapL(String(row.product_description))
        const bullets = [row.bullet_point1,row.bullet_point2,row.bullet_point3,row.bullet_point4,row.bullet_point5].filter(Boolean)
        if (bullets.length) attrs.bullet_point = bullets.map((b) => ({ value: String(b), language_tag: languageTag, marketplace_id: marketplaceId }))
        if (row.generic_keyword)    attrs.generic_keyword     = wrapL(String(row.generic_keyword))
        if (row.color)              attrs.color               = [{ value: String(row.color), language_tag: languageTag, marketplace_id: marketplaceId }]
        if (row.external_product_id && row.external_product_id_type)
          attrs.externally_assigned_product_identifier = [{ type: String(row.external_product_id_type).toLowerCase(), value: String(row.external_product_id), marketplace_id: marketplaceId }]
        if (row.price_eur) attrs.purchasable_offer = [{ currency: CURRENCY_MAP[mp] ?? 'EUR', our_price: [{ schedule: [{ value_with_tax: parseFloat(String(row.price_eur)) }] }], marketplace_id: marketplaceId }]
        if (row.quantity)  attrs.fulfillment_availability = [{ fulfillment_channel_code: String(row.fulfillment_channel_code || 'DEFAULT'), quantity: parseInt(String(row.quantity), 10), marketplace_id: marketplaceId }]
        if (row.parentage_level === 'parent' && row.variation_theme) attrs.variation_theme = wrap(String(row.variation_theme))
        if (row.parentage_level === 'child' && row.parent_sku) {
          attrs.parentage_level      = [{ value: 'child', marketplace_id: marketplaceId }]
          attrs.child_parent_sku_relationship = [{ parent_sku: String(row.parent_sku), marketplace_id: marketplaceId }]
        }
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith('_') || !k.startsWith('attr_') || !v) continue
          attrs[k.slice(5)] = wrap(String(v))
        }
        return {
          messageId: i + 1, sku: String(row.item_sku), operationType, productType,
          requirements: row.parentage_level === 'parent' ? 'LISTING_PRODUCT_ONLY' : 'LISTING',
          attributes: attrs,
        }
      })

    return JSON.stringify({ header: { sellerId, version: '2.0', issueLocale: languageTag.replace('_', '-') }, messages })
  }

  buildTsvExport(manifest: FlatFileManifest, rows: FlatFileRow[]): string {
    const allCols = manifest.groups.flatMap((g) => g.columns)
    const colIds  = allCols.map((c) => c.id)
    const meta    = `TemplateType=customizable\tVersion=2025.0\tProductType=${manifest.productType}\tMarketplace=${manifest.marketplace}`
    const hdrEn   = allCols.map((c) => c.labelEn).join('\t')
    const hdrIt   = allCols.map((c) => c.labelLocal).join('\t')
    const hdrRef  = allCols.map((c) => c.fieldRef).join('\t')
    const hdrReq  = allCols.map((c) => c.required ? 'Required' : 'Optional').join('\t')
    const data    = rows.map((row) => colIds.map((id) => {
      const v = row[id]
      return v == null ? '' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
    }).join('\t'))
    return [meta, hdrEn, hdrIt, hdrRef, hdrReq, ...data].join('\r\n')
  }

  parseTsv(content: string, productType: string): FlatFileRow[] {
    const lines = content.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) return []
    let headerLine = 0
    while (headerLine < lines.length && lines[headerLine].startsWith('TemplateType')) headerLine++
    if (headerLine >= lines.length) return []
    const cols = lines[headerLine].split('\t').map((c) => c.trim().toLowerCase())
    const dataStart = headerLine + 1
    const firstData = lines[dataStart] ?? ''
    const isAnnotation = /^required|^optional|^conditional/i.test(firstData.split('\t')[0] ?? '')
    const rowStart = isAnnotation ? dataStart + 1 : dataStart
    return lines.slice(rowStart).map((line, idx) => {
      const cells = line.split('\t')
      const row: FlatFileRow = {
        _rowId: `import-${idx}`, _isNew: false, _status: 'idle',
        product_type: productType, record_action: 'full_update',
        item_sku: '', parentage_level: '', parent_sku: '', variation_theme: '',
        item_name: '', brand: '', external_product_id_type: '', external_product_id: '',
        product_description: '',
        bullet_point1: '', bullet_point2: '', bullet_point3: '', bullet_point4: '', bullet_point5: '',
        generic_keyword: '', price_eur: '', quantity: '', fulfillment_channel_code: '', skip_offer: '',
        condition_type: '', list_price: '', country_of_origin: '', color: '',
        main_image_url: '', model_number: '', manufacturer: '',
      }
      cols.forEach((col, i) => {
        const val = cells[i]?.trim() ?? ''
        if (!val) return
        if (col in row) (row as any)[col] = val
        else row[`attr_${col}`] = val
      })
      return row
    }).filter((r) => String(r.item_sku).length > 0)
  }
}

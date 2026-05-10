/**
 * Amazon Flat-File Spreadsheet Service
 *
 * Generates a column manifest that mirrors Amazon's official flat-file
 * template structure (as downloaded from Seller Central), including:
 *   - Exact Amazon group order and Italian labels
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
  labelIt: string     // Italian label (from Amazon IT flat file)
  description?: string
  required: boolean
  kind: FlatFileColumnKind
  options?: string[]  // Valid values / enum choices
  maxLength?: number
  width: number
}

export interface FlatFileColumnGroup {
  id: string
  labelEn: string   // English group name
  labelIt: string   // Italian group name (as in Amazon file)
  color: string     // Tailwind colour prefix
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

// ── Italian label dictionary (from actual COAT.xlsm Amazon IT file) ───

const IT_LABELS: Record<string, string> = {
  // Offer Identity
  'item_sku':              'SKU',
  'product_type':          'Tipo di prodotto',
  'record_action':         "Azione sull'offerta",
  // Variations
  'parentage_level':       'Livello di parentela',
  'parent_sku':            'SKU articolo Parent (principale)',
  'variation_theme':       'Variazione del Tema del Nome',
  // Product Identity
  'item_name':             "Nome dell'articolo",
  'brand':                 'Nome del marchio',
  'external_product_id_type': 'Tipo ID di prodotto',
  'external_product_id':   'ID prodotto',
  'browse_node_1':         'Nodi di navigazione consigliati',
  'browse_node_2':         'Nodi di navigazione consigliati',
  'browse_node_3':         'Nodi di navigazione consigliati',
  'browse_node_4':         'Nodi di navigazione consigliati',
  'browse_node_5':         'Nodi di navigazione consigliati',
  'collar_style_1':        'Stile del colletto',
  'collar_style_2':        'Stile del colletto',
  'model_number':          'Numero di modello',
  'model_name':            'Nome del modello',
  'manufacturer':          'Produttore',
  // Images
  'main_image_url':        'URL immagine principale',
  'other_image_url_1':     'URL altra immagine',
  'other_image_url_2':     'URL altra immagine',
  'other_image_url_3':     'URL altra immagine',
  'other_image_url_4':     'URL altra immagine',
  'other_image_url_5':     'URL altra immagine',
  'other_image_url_6':     'URL altra immagine',
  'other_image_url_7':     'URL altra immagine',
  'other_image_url_8':     'URL altra immagine',
  'swatch_image_url':      'URL immagine campione',
  // Product Details
  'product_description':   'Descrizione del prodotto',
  'bullet_point1':         'Punto elenco',
  'bullet_point2':         'Punto elenco',
  'bullet_point3':         'Punto elenco',
  'bullet_point4':         'Punto elenco',
  'bullet_point5':         'Punto elenco',
  'generic_keyword':       'Chiavi di ricerca',
  'special_feature1':      'Funzionalità speciali',
  'special_feature2':      'Funzionalità speciali',
  'special_feature3':      'Funzionalità speciali',
  'special_feature4':      'Funzionalità speciali',
  'special_feature5':      'Funzionalità speciali',
  'lifestyle':             'Stile di vita',
  'style':                 'Stile',
  'department':            'Pubblico di Destinazione',
  'target_gender':         'Sesso a cui è destinato',
  'age_range_description': 'Descrizione della fascia di età',
  'apparel_size_system':   'Sistema delle taglie di abbigliamento',
  'apparel_size_class':    'Formato delle taglie di abbigliamento',
  'apparel_size':          'Taglia abbigliamento',
  'apparel_size_to':       'Limite superiore della taglia',
  'apparel_body_type':     'Tipo di corporatura',
  'apparel_height_type':   'Altezza',
  'material1':             'Materiale',
  'material2':             'Materiale',
  'material3':             'Materiale',
  'fabric_type':           'Tipo di tessuto',
  'lining_description':    'Descrizione rivestimento',
  'number_of_items':       'Numero di articoli',
  'item_package_quantity': 'Quantità per pacco',
  'item_type_name':        'Nome del tipo di prodotto',
  'water_resistance_level':'Livello di resistenza all\'acqua',
  'special_size_type':     'Taglie speciali',
  'color_map':             'Mappa dei colori',
  'color':                 'Colore',
  'item_length_description': 'Descrizione della lunghezza',
  'part_number':           'Numero Di Parte',
  'theme':                 'Tema',
  'fit_type':              'Tipo di Vestibilità',
  'leg_length':            'Lunghezza della gamba',
  'leg_length_unit':       'Unità lunghezza gamba',
  'pocket_description1':   'Descrizione della tasca',
  'pocket_description2':   'Descrizione della tasca',
  'pocket_description3':   'Descrizione della tasca',
  'pocket_description4':   'Descrizione della tasca',
  'pocket_description5':   'Descrizione della tasca',
  'weave_type':            'Tipo di tessitura',
  'care_instructions':     'Istruzioni per la Manutenzione',
  'pattern':               'Motivo',
  'sport_type':            'Tipo di sport',
  'coat_silhouette_type':  'Linea della giacca',
  'closure_type':          'Tipo di chiusura',
  'sleeve_length':         'Descrizione della lunghezza della manica',
  'sleeve_type':           'Tipo di manica',
  'number_of_pockets':     'Numero di tasche',
  // Offer
  'skip_offer':            "Ignora l'offerta",
  'condition_type':        "Condizione dell'articolo",
  'condition_note':        "Nota sulle condizioni",
  'list_price':            'Prezzo al pubblico consigliato (IVA inclusa)',
  'product_tax_code':      'Codice fiscale del prodotto',
  'merchant_release_date': 'Data di uscita',
  'max_order_quantity':    'Quantitativo massimo ordine',
  // Offer IT
  'fulfillment_channel_code': 'Codice canale di gestione (IT)',
  'quantity':              'Quantità (IT)',
  'lead_time_to_ship':     'Tempo di gestione (IT)',
  'restock_date':          'Data di rifornimento (IT)',
  'is_inventory_available':'Inventario sempre disponibile (IT)',
  'price_eur':             'Prezzo EUR (Vendita su Amazon, IT)',
  'min_price':             'Prezzo minimo consentito al venditore (IT)',
  'max_price':             'Prezzo massimo consentito al venditore (IT)',
  'sale_price':            'Prezzo di vendita EUR (IT)',
  'sale_start_date':       'Data inizio vendita (IT)',
  'sale_end_date':         'Data fine vendita (IT)',
  'offer_start_date':      "Data di inizio dell'offerta (IT)",
  'offer_end_date':        "Data interruzione della vendita (IT)",
  'merchant_shipping_group':'Modello di spedizione (IT)',
  // Shipping
  'pkg_length':            'Lunghezza imballaggio',
  'pkg_length_unit':       'Unità lunghezza imballaggio',
  'pkg_width':             'Larghezza imballaggio',
  'pkg_width_unit':        'Unità larghezza imballaggio',
  'pkg_height':            'Altezza imballaggio',
  'pkg_height_unit':       'Unità altezza imballaggio',
  'pkg_weight':            'Peso imballaggio',
  'pkg_weight_unit':       'Unità peso imballaggio',
  // Compliance
  'country_of_origin':     'Paese di origine',
  'batteries_required':    'Le batterie sono necessarie?',
  'batteries_included':    'Le batterie sono incluse?',
  'item_weight':           "Peso dell'articolo",
  'item_weight_unit':      "Unità peso dell'articolo",
}

function itLabel(id: string, fallback: string): string {
  return IT_LABELS[id] ?? fallback
}

// ── Fixed group definitions (Amazon's exact structure) ─────────────────

function offerIdentityGroup(variationThemes: string[]): FlatFileColumnGroup {
  return {
    id: 'offer_identity',
    labelEn: 'Offer Identity',
    labelIt: "Identità dell'offerta",
    color: 'blue',
    columns: [
      { id: 'item_sku',       fieldRef: 'contribution_sku#1.value',  labelEn: 'Seller SKU',    labelIt: itLabel('item_sku', 'SKU'),         required: true,  kind: 'text',   width: 180 },
      { id: 'product_type',   fieldRef: 'product_type#1.value',       labelEn: 'Product Type',  labelIt: itLabel('product_type', 'Tipo di prodotto'), required: true, kind: 'text', width: 140 },
      { id: 'record_action',  fieldRef: '::record_action',            labelEn: 'Operation',     labelIt: itLabel('record_action', "Azione sull'offerta"), required: true, kind: 'enum', width: 130,
        options: ['full_update', 'partial_update', 'delete'],
        description: 'full_update = create or replace; partial_update = merge fields; delete = remove' },
    ],
  }
}

function variationsGroup(variationThemes: string[]): FlatFileColumnGroup {
  return {
    id: 'variations',
    labelEn: 'Variations',
    labelIt: 'Variazioni',
    color: 'purple',
    columns: [
      { id: 'parentage_level', fieldRef: 'parentage_level[marketplace_id]#1.value', labelEn: 'Parent/Child', labelIt: itLabel('parentage_level', 'Livello di parentela'), required: false, kind: 'enum', width: 110,
        options: ['', 'parent', 'child'], description: 'Leave blank for standalone. "parent" = non-buyable variation parent. "child" = variant.' },
      { id: 'parent_sku', fieldRef: 'child_parent_sku_relationship[marketplace_id]#1.parent_sku', labelEn: 'Parent SKU', labelIt: itLabel('parent_sku', 'SKU articolo Parent'), required: false, kind: 'text', width: 170,
        description: 'Required when parentage_level = child' },
      { id: 'variation_theme', fieldRef: 'variation_theme#1.name', labelEn: 'Variation Theme', labelIt: itLabel('variation_theme', 'Variazione Tema'), required: false, kind: 'enum', width: 170,
        options: ['', ...variationThemes],
        description: 'Required on parent rows. e.g. COLORE, DIMENSIONI/COLORE' },
    ],
  }
}

function productIdentityGroup(schemaEnums: Record<string, string[]>): FlatFileColumnGroup {
  return {
    id: 'product_identity',
    labelEn: 'Product Identity',
    labelIt: 'Identità prodotto',
    color: 'emerald',
    columns: [
      { id: 'item_name',      fieldRef: 'item_name[marketplace_id][language_tag]#1.value', labelEn: 'Title', labelIt: itLabel('item_name', "Nome dell'articolo"), required: true, kind: 'text', width: 300, maxLength: 200 },
      { id: 'brand',          fieldRef: 'brand[marketplace_id][language_tag]#1.value',     labelEn: 'Brand', labelIt: itLabel('brand', 'Nome del marchio'),        required: true, kind: 'text', width: 140 },
      { id: 'external_product_id_type', fieldRef: 'amzn1.volt.ca.product_id_type', labelEn: 'ID Type', labelIt: itLabel('external_product_id_type', 'Tipo ID prodotto'), required: false, kind: 'enum', width: 90, options: ['', 'EAN', 'UPC', 'GTIN', 'ISBN', 'ASIN'] },
      { id: 'external_product_id',      fieldRef: 'amzn1.volt.ca.product_id_value', labelEn: 'EAN / UPC / GTIN', labelIt: itLabel('external_product_id', 'ID prodotto'), required: false, kind: 'text', width: 160 },
      { id: 'browse_node_1',  fieldRef: 'recommended_browse_nodes[marketplace_id]#1.value', labelEn: 'Browse Node 1', labelIt: itLabel('browse_node_1', 'Nodi di navigazione 1'), required: false, kind: 'text', width: 150 },
      { id: 'browse_node_2',  fieldRef: 'recommended_browse_nodes[marketplace_id]#2.value', labelEn: 'Browse Node 2', labelIt: itLabel('browse_node_2', 'Nodi di navigazione 2'), required: false, kind: 'text', width: 150 },
      { id: 'model_number',   fieldRef: 'model_number[marketplace_id]#1.value', labelEn: 'Model Number', labelIt: itLabel('model_number', 'Numero di modello'), required: false, kind: 'text', width: 130 },
      { id: 'model_name',     fieldRef: 'model_name[marketplace_id][language_tag]#1.value', labelEn: 'Model Name', labelIt: itLabel('model_name', 'Nome del modello'), required: false, kind: 'text', width: 150 },
      { id: 'manufacturer',   fieldRef: 'manufacturer[marketplace_id][language_tag]#1.value', labelEn: 'Manufacturer', labelIt: itLabel('manufacturer', 'Produttore'), required: false, kind: 'text', width: 150 },
    ],
  }
}

function imagesGroup(): FlatFileColumnGroup {
  const imgCol = (id: string, ref: string, labelEn: string): FlatFileColumn => ({
    id, fieldRef: ref, labelEn, labelIt: itLabel(id, labelEn), required: false, kind: 'text', width: 220,
    description: 'Full HTTPS URL to image (min 1000px, white background)',
  })
  return {
    id: 'images',
    labelEn: 'Images',
    labelIt: 'Immagini',
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

function productDetailsGroup(schemaEnums: Record<string, string[]>): FlatFileColumnGroup {
  function col(id: string, ref: string, labelEn: string, overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return {
      id, fieldRef: ref, labelEn, labelIt: itLabel(id, labelEn),
      required: false, kind: 'text', width: 160, ...overrides,
    }
  }
  function enumCol(id: string, ref: string, labelEn: string, options: string[], overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return col(id, ref, labelEn, { kind: 'enum', options: ['', ...options.filter(Boolean)], width: 150, ...overrides })
  }

  const genderOpts = schemaEnums['target_gender'] ?? ['male', 'female', 'unisex']
  const colorMapOpts = schemaEnums['color'] ?? []
  const conditionOpts = schemaEnums['condition_type'] ?? ['New']

  return {
    id: 'product_details',
    labelEn: 'Product Details',
    labelIt: 'Dettagli prodotto',
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
      col('department','department[marketplace_id][language_tag]#1.value','Target Audience / Department', { width: 180 }),
      enumCol('target_gender','target_gender[marketplace_id]#1.value','Target Gender', genderOpts, { width: 120 }),
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

function offerGroup(schemaEnums: Record<string, string[]>): FlatFileColumnGroup {
  return {
    id: 'offer',
    labelEn: 'Offer',
    labelIt: 'Offerta',
    color: 'amber',
    columns: [
      { id: 'skip_offer',   fieldRef: 'skip_offer[marketplace_id]#1.value',    labelEn: 'Skip Offer',    labelIt: itLabel('skip_offer', "Ignora l'offerta"),       required: false, kind: 'enum',   width: 100, options: ['', 'true', 'false'] },
      { id: 'condition_type',fieldRef:'condition_type[marketplace_id]#1.value', labelEn: 'Condition',     labelIt: itLabel('condition_type', "Condizione"),        required: false, kind: 'enum',   width: 120, options: ['', 'new_new', ...(schemaEnums['condition_type'] ?? ['new_new'])] },
      { id: 'condition_note',fieldRef:'condition_note[marketplace_id][language_tag]#1.value', labelEn: 'Condition Note', labelIt: itLabel('condition_note', 'Nota condizione'), required: false, kind: 'text', width: 180 },
      { id: 'list_price',   fieldRef: 'list_price[marketplace_id]#1.value_with_tax', labelEn: 'RRP (incl. VAT)', labelIt: itLabel('list_price', 'Prezzo al pubblico consigliato'), required: false, kind: 'number', width: 120 },
      { id: 'product_tax_code', fieldRef: 'product_tax_code#1.value', labelEn: 'Tax Code', labelIt: itLabel('product_tax_code', 'Codice fiscale del prodotto'), required: false, kind: 'text', width: 110 },
      { id: 'merchant_release_date', fieldRef: 'merchant_release_date[marketplace_id]#1.value', labelEn: 'Release Date', labelIt: itLabel('merchant_release_date', 'Data di uscita'), required: false, kind: 'text', width: 120 },
      { id: 'max_order_quantity', fieldRef: 'max_order_quantity[marketplace_id]#1.value', labelEn: 'Max Order Qty', labelIt: itLabel('max_order_quantity', 'Quantitativo massimo ordine'), required: false, kind: 'number', width: 110 },
    ],
  }
}

function offerItGroup(defaultCurrency: string): FlatFileColumnGroup {
  return {
    id: 'offer_it',
    labelEn: 'Offer (IT) — Amazon.it',
    labelIt: 'Offerta (IT) - (Vendita su Amazon)',
    color: 'yellow',
    columns: [
      { id: 'fulfillment_channel_code', fieldRef: 'fulfillment_availability#1.fulfillment_channel_code', labelEn: 'Fulfillment Channel', labelIt: itLabel('fulfillment_channel_code', 'Codice canale di gestione'), required: false, kind: 'enum', width: 150, options: ['', 'DEFAULT', 'AMAZON_EU'] },
      { id: 'quantity',         fieldRef: 'fulfillment_availability#1.quantity',    labelEn: 'Quantity',    labelIt: itLabel('quantity', 'Quantità'),        required: false, kind: 'number', width: 80 },
      { id: 'lead_time_to_ship',fieldRef: 'fulfillment_availability#1.lead_time_to_ship_max_days', labelEn: 'Handling Days', labelIt: itLabel('lead_time_to_ship', 'Tempo di gestione'), required: false, kind: 'number', width: 110 },
      { id: 'price_eur',        fieldRef: `purchasable_offer[marketplace_id][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`, labelEn: `Price ${defaultCurrency} (incl. VAT)`, labelIt: itLabel('price_eur', `Prezzo ${defaultCurrency}`), required: false, kind: 'number', width: 130 },
      { id: 'sale_price',       fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.value_with_tax', labelEn: 'Sale Price', labelIt: itLabel('sale_price', 'Prezzo di vendita'), required: false, kind: 'number', width: 110 },
      { id: 'sale_start_date',  fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.start_at', labelEn: 'Sale Start', labelIt: itLabel('sale_start_date', 'Data inizio vendita'), required: false, kind: 'text', width: 120 },
      { id: 'sale_end_date',    fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.discounted_price#1.schedule#1.end_at', labelEn: 'Sale End', labelIt: itLabel('sale_end_date', 'Data fine vendita'), required: false, kind: 'text', width: 120 },
      { id: 'min_price',        fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax', labelEn: 'Min Price', labelIt: itLabel('min_price', 'Prezzo minimo'), required: false, kind: 'number', width: 100 },
      { id: 'max_price',        fieldRef: 'purchasable_offer[marketplace_id][audience=ALL]#1.maximum_seller_allowed_price#1.schedule#1.value_with_tax', labelEn: 'Max Price', labelIt: itLabel('max_price', 'Prezzo massimo'), required: false, kind: 'number', width: 100 },
      { id: 'merchant_shipping_group', fieldRef: 'merchant_shipping_group[marketplace_id]#1.value', labelEn: 'Shipping Template', labelIt: itLabel('merchant_shipping_group', 'Modello di spedizione'), required: false, kind: 'text', width: 160 },
    ],
  }
}

function shippingGroup(): FlatFileColumnGroup {
  function dimCol(id: string, ref: string, labelEn: string, labelIt: string, isUnit = false): FlatFileColumn {
    return {
      id, fieldRef: ref, labelEn, labelIt,
      required: false, kind: isUnit ? 'enum' : 'number', width: isUnit ? 100 : 90,
      options: isUnit ? ['', 'centimeters', 'meters', 'inches', 'millimeters'] : undefined,
    }
  }
  return {
    id: 'shipping',
    labelEn: 'Shipping',
    labelIt: 'Spedizione',
    color: 'sky',
    columns: [
      dimCol('pkg_length',      'item_package_dimensions[marketplace_id]#1.length.value',  'Pkg Length',       itLabel('pkg_length', 'Lunghezza imballaggio')),
      dimCol('pkg_length_unit', 'item_package_dimensions[marketplace_id]#1.length.unit',   'Pkg Length Unit',  itLabel('pkg_length_unit', 'Unità lunghezza'), true),
      dimCol('pkg_width',       'item_package_dimensions[marketplace_id]#1.width.value',   'Pkg Width',        itLabel('pkg_width', 'Larghezza imballaggio')),
      dimCol('pkg_width_unit',  'item_package_dimensions[marketplace_id]#1.width.unit',    'Pkg Width Unit',   itLabel('pkg_width_unit', 'Unità larghezza'), true),
      dimCol('pkg_height',      'item_package_dimensions[marketplace_id]#1.height.value',  'Pkg Height',       itLabel('pkg_height', 'Altezza imballaggio')),
      dimCol('pkg_height_unit', 'item_package_dimensions[marketplace_id]#1.height.unit',   'Pkg Height Unit',  itLabel('pkg_height_unit', 'Unità altezza'), true),
      dimCol('pkg_weight',      'item_package_weight[marketplace_id]#1.value',             'Pkg Weight',       itLabel('pkg_weight', 'Peso imballaggio')),
      { id: 'pkg_weight_unit', fieldRef: 'item_package_weight[marketplace_id]#1.unit', labelEn: 'Pkg Weight Unit', labelIt: itLabel('pkg_weight_unit', 'Unità peso'), required: false, kind: 'enum', width: 100, options: ['', 'grams', 'kilograms', 'pounds', 'ounces'] },
    ],
  }
}

function complianceGroup(schemaEnums: Record<string, string[]>): FlatFileColumnGroup {
  function col(id: string, ref: string, labelEn: string, overrides: Partial<FlatFileColumn> = {}): FlatFileColumn {
    return { id, fieldRef: ref, labelEn, labelIt: itLabel(id, labelEn), required: false, kind: 'text', width: 150, ...overrides }
  }
  return {
    id: 'compliance',
    labelEn: 'Compliance & Safety',
    labelIt: 'Conformità e sicurezza',
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

function schemaFieldToColumn(fieldId: string, prop: Record<string, any>, isRequired: boolean): FlatFileColumn | null {
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
    return null // skip complex/unsupported
  }

  const labelEn = fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return {
    id: `attr_${fieldId}`,
    fieldRef: fieldId,
    labelEn,
    labelIt: IT_LABELS[fieldId] ?? labelEn,
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
      const col = schemaFieldToColumn(fieldId, prop as Record<string, any>, requiredSet.has(fieldId))
      if (col) dynamicCols.push(col)
    }
    dynamicCols.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      return a.labelEn.localeCompare(b.labelEn)
    })

    const currency = CURRENCY_MAP[mp] ?? 'EUR'

    const groups: FlatFileColumnGroup[] = [
      offerIdentityGroup(variationThemes),
      variationsGroup(variationThemes),
      productIdentityGroup(schemaEnums),
      imagesGroup(),
      productDetailsGroup(schemaEnums),
      offerGroup(schemaEnums),
      offerItGroup(currency),
      shippingGroup(),
      complianceGroup(schemaEnums),
    ]

    if (dynamicCols.length > 0) {
      groups.push({
        id: 'other_attributes',
        labelEn: 'Other Attributes',
        labelIt: 'Altri attributi',
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
    const hdrIt   = allCols.map((c) => c.labelIt).join('\t')
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

/**
 * CFI test fixtures — minimal OOXML workbooks built in the test, never the Owner's originals.
 *
 * `ooxmlWorkbook` writes only the parts a zip walker reads (workbook, relationships, shared strings, sheets).
 * `complete: true` adds the package parts ExcelJS needs, so a fixture can also prove the ExcelJS branch runs.
 */
import JSZip from 'jszip'

export interface FixtureSheet { name: string; rows: Record<number, string[]> }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const col = (n: number): string => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s }

export async function ooxmlWorkbook(opts: { sheets: FixtureSheet[]; strict?: boolean; sharedStrings?: boolean; complete?: boolean; extraSharedStrings?: string[] }): Promise<Buffer> {
  const main = opts.strict ? 'http://purl.oclc.org/ooxml/spreadsheetml/main' : 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = opts.strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const strings: string[] = [...(opts.extraSharedStrings ?? [])], index = new Map<string, number>()
  const cell = (ref: string, value: string) => {
    if (!opts.sharedStrings) return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`
    if (!index.has(value)) { index.set(value, strings.length); strings.push(value) }
    return `<c r="${ref}" t="s"><v>${index.get(value)}</v></c>`
  }
  const zip = new JSZip()
  opts.sheets.forEach((sheet, i) => {
    const rows = Object.entries(sheet.rows).map(([r, values]) => `<row r="${r}">${values.map((v, c) => v === '' ? '' : cell(`${col(c + 1)}${r}`, v)).join('')}</row>`).join('')
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${main}"><sheetData>${rows}</sheetData></worksheet>`)
  })
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${main}" xmlns:r="${rel}"${opts.strict ? ' conformance="strict"' : ''}><sheets>${
    opts.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    opts.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}${
    strings.length ? `<Relationship Id="rId${opts.sheets.length + 1}" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`)
  if (strings.length) zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${main}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`)
  if (opts.complete) {
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
      opts.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${
      strings.length ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}</Types>`)
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  }
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }))
}

/** Italy, new grammar: settings in A1, labels row 4, keys row 5, data from row 7 — the FINAL files' shape. */
const MP = 'APJ6JRA9NG5V4'
export const AMAZON_KEYS = [
  'contribution_sku#1.value', 'product_type#1.value', '::record_action',
  `parentage_level[marketplace_id=${MP}]#1.value`, `child_parent_sku_relationship[marketplace_id=${MP}]#1.parent_sku`, 'variation_theme#1.name',
  `item_name[marketplace_id=${MP}][language_tag=it_IT]#1.value`, `brand[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  ...[1, 2, 3, 4, 5].map(n => `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#${n}.value`),
  `color[marketplace_id=${MP}][language_tag=it_IT]#1.value`, `material[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  `apparel_size[marketplace_id=${MP}]#1.size_system`, `apparel_size[marketplace_id=${MP}]#1.size`,
  'fulfillment_availability#1.fulfillment_channel_code', 'fulfillment_availability#1.quantity',
  `purchasable_offer[marketplace_id=${MP}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`, `list_price[marketplace_id=${MP}]#1.value_with_tax`,
  `model_name[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
]
export const AMAZON_SETTINGS_IT = 'settings=feedType=256&primaryMarketplaceId=amzn1.mp.o.APJ6JRA9NG5V4&contentLanguageTag=it_IT&templateIdentifier=cfi-fixture&headerLanguageTag=it_IT'

export function amazonTemplateSheets(opts: { rows?: string[][] } = {}): FixtureSheet[] {
  const data = opts.rows ?? [['CFI-PARENT', 'COAT', 'Crea o sostituisci (aggiornamento completo)', 'Articolo parent', '', 'SIZE/COLOR', 'Giacca CFI', 'XAVIA']]
  return [
    { name: 'Istruzioni', rows: { 1: ['Leggimi'] } },
    // The vertical dictionary: attribute keys in a column, never a dense row — must not be taken for the template.
    { name: 'Definizioni dati', rows: { 4: ['', 'contribution_sku#1.value', 'SKU'], 5: ['', 'product_type#1.value', 'Tipo di prodotto'], 6: ['', '::record_action', 'Azione'] } },
    { name: 'Modello', rows: { 1: [AMAZON_SETTINGS_IT], 3: ["Identità dell'offerta"], 4: ['SKU', 'Tipo di prodotto', 'Azione sull’offerta'], 5: AMAZON_KEYS,
      ...Object.fromEntries(data.map((row, i) => [7 + i, row])) } },
  ]
}

/** The 2019-era flat file: `TemplateType=fptcustom` in A1, labels row 2, snake_case keys row 3. */
export function oldAmazonFlatFileSheets(): FixtureSheet[] {
  const keys = ['feed_product_type', 'item_sku', 'brand_name', 'item_name', 'external_product_id', 'external_product_id_type', 'standard_price', 'quantity',
    'parent_child', 'parent_sku', 'relationship_type', 'variation_theme', 'update_delete', 'color_name', 'size_name', 'department_name',
    'bullet_point1', 'bullet_point2', 'bullet_point3', 'generic_keywords', 'main_image_url']
  return [{ name: 'Modello', rows: { 1: ['TemplateType=fptcustom', 'Version=2019.0512'], 2: keys.map(k => k.toUpperCase()), 3: keys, 4: ['coat', 'CFI-OLD-1', 'XAVIA', 'Giacca'] } }]
}

/** Our eBay workbook's header row (a trimmed set of its 79 columns). */
export const EBAY_HEADERS = ['SKU', 'Action', 'Parent/Child', 'Parent SKU', 'Item ID', 'Listing ID', 'EAN', 'Title', 'Condition', 'Category ID', 'Variation Theme', 'Price (€)', 'Quantity']

/** The Title-Case SP-API sheet (`amazon_OUTERWEAR_IT.xlsx`). */
export const ATTRIBUTE_SHEET_HEADERS = ['Seller SKU', 'Product Type', 'Operation', 'Parent/Child', 'Parent SKU', 'Variation Theme', 'Item Name', 'Brand']

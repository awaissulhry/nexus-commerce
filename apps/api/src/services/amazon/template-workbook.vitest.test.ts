/**
 * A2 (XLSM hybrid) — Amazon official-template workbook reader tests.
 *
 * Fixtures are built programmatically with jszip so the suite carries no
 * binary files. They mirror the structures verified on the real Xavia
 * templates (AIREON IT/DE/ES/FR, X-RACING IT):
 *   • localized sheet names, labels row 4 / attrs row 5 / blank row 6 / data 7+
 *   • the vertical "Definizioni dati" dictionary sheet that must NOT match
 *   • DE/ES/FR's ABSOLUTE `/xl/…` worksheet rel targets
 *   • settings blob in A1 (templateIdentifier / primaryMarketplaceId / tags)
 *   • localized ::record_action tokens incl. delete
 *   • legacy `TemplateType=fptcustom` grammar (item_sku, labels row 2, ids row 3)
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  detectAmazonTemplate,
  classifyRecordAction,
  decodeXml,
} from './template-workbook.js'

// ── fixture plumbing ─────────────────────────────────────────────────────────

type CellSpec = { col: number; v: string; t?: 's' | 'inlineStr' | 'n' }
type RowSpec = { r: number; cells: CellSpec[] }

function colName(n: number): string {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sheetXml(rows: RowSpec[]): string {
  const body = rows
    .map((row) => {
      if (row.cells.length === 0) return `<row r="${row.r}"/>`
      const cells = row.cells
        .map((c) => {
          const ref = `${colName(c.col)}${row.r}`
          if (c.t === 'inlineStr') return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.v)}</t></is></c>`
          if (c.t === 's') return `<c r="${ref}" t="s"><v>${c.v}</v></c>`
          if (c.t === 'n') return `<c r="${ref}"><v>${c.v}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.v)}</t></is></c>`
        })
        .join('')
      return `<row r="${row.r}">${cells}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

async function buildWorkbook(opts: {
  sheets: Array<{ name: string; rows: RowSpec[] }>
  sharedStrings?: string[]
  absoluteRels?: boolean
}): Promise<Uint8Array> {
  const zip = new JSZip()
  const sheetTags = opts.sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets><definedNames><definedName name="junk">Sheet1!$A$1</definedName></definedNames></workbook>`,
  )
  const rels = opts.sheets
    .map((_, i) => {
      const target = opts.absoluteRels ? `/xl/worksheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`
      return `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`
    })
    .join('')
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  )
  if (opts.sharedStrings && opts.sharedStrings.length > 0) {
    const sis = opts.sharedStrings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')
    zip.file(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${opts.sharedStrings.length}" uniqueCount="${opts.sharedStrings.length}">${sis}</sst>`,
    )
  }
  opts.sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)))
  return zip.generateAsync({ type: 'uint8array' })
}

// v2 attr row — 22 attribute-path cells, mirroring the real COAT_PANTS shape.
const MP = 'APJ6JRA9NG5V4'
const V2_ATTRS = [
  'contribution_sku#1.value',
  'product_type#1.value',
  '::record_action',
  `parentage_level[marketplace_id=${MP}]#1.value`,
  `child_parent_sku_relationship[marketplace_id=${MP}]#1.parent_sku`,
  'variation_theme#1.name',
  `item_name[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#2.value`,
  `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#3.value`,
  `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#4.value`,
  `bullet_point[marketplace_id=${MP}][language_tag=it_IT]#5.value`,
  `color[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  `apparel_size[marketplace_id=${MP}]#1.size_system`,
  `apparel_size[marketplace_id=${MP}]#1.size_class`,
  `apparel_size[marketplace_id=${MP}]#1.size`,
  'fulfillment_availability#1.fulfillment_channel_code',
  'fulfillment_availability#1.quantity',
  `purchasable_offer[marketplace_id=${MP}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`,
  `list_price[marketplace_id=${MP}]#1.value_with_tax`,
  `team_name[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
  `athlete[marketplace_id=${MP}][language_tag=it_IT]#1.value`,
]
const SETTINGS_IT =
  'settings=feedType=256&timestamp=2026-07-13T21%3A09%3A21.608Z&primaryMarketplaceId=amzn1.mp.o.APJ6JRA9NG5V4&contentLanguageTag=it_IT&templateIdentifier=a0fb4d0d-test&headerLanguageTag=it_IT'

function attrRowSpec(r: number): RowSpec {
  return { r, cells: V2_ATTRS.map((a, i) => ({ col: i + 1, v: a })) }
}

/** The vertical dictionary sheet — real files' "Definizioni dati" trap. */
const TRAP_SHEET = {
  name: 'Definizioni dati',
  rows: [
    { r: 1, cells: [{ col: 1, v: 'Come completare il modello inventario' }] },
    { r: 3, cells: [{ col: 1, v: "Identità dell'offerta" }] },
    { r: 4, cells: [{ col: 2, v: 'contribution_sku#1.value' }, { col: 3, v: 'SKU' }, { col: 4, v: 'Questo attributo…' }] },
    { r: 5, cells: [{ col: 2, v: 'product_type#1.value' }, { col: 3, v: 'Tipo di prodotto' }] },
    { r: 6, cells: [{ col: 2, v: '::record_action' }, { col: 3, v: 'Azione' }] },
  ] as RowSpec[],
}

async function buildV2Fixture(): Promise<Uint8Array> {
  return buildWorkbook({
    sharedStrings: ['AIREON-JACKET-CREMA-E-VINO-MEN-M', 'Modifica (aggiornamento parziale)'],
    sheets: [
      { name: 'Istruzioni', rows: [{ r: 1, cells: [{ col: 1, v: 'Leggimi' }] }] },
      TRAP_SHEET,
      {
        name: 'Modello',
        rows: [
          { r: 1, cells: [{ col: 1, v: SETTINGS_IT }] },
          { r: 4, cells: [{ col: 1, v: 'SKU' }, { col: 2, v: 'Tipo di prodotto' }, { col: 3, v: 'Azione sull’offerta' }] },
          attrRowSpec(5),
          { r: 6, cells: [] },
          {
            r: 7,
            cells: [
              { col: 1, v: 'AIREON' }, { col: 2, v: 'COAT' },
              { col: 4, v: 'Articolo parent' }, { col: 6, v: 'TEAM_NAME/ATHLETE/SIZE/COLOR' },
              { col: 7, v: 'Giacca Moto Uomo & Donna' }, // & → entity round-trip
            ],
          },
          {
            r: 8,
            cells: [
              { col: 1, v: '0', t: 's' }, // shared-string SKU
              { col: 2, v: 'COAT' },
              { col: 3, v: '1', t: 's' }, // shared-string partial-update action
              { col: 4, v: 'Bambino' },
              { col: 5, v: 'AIREON' },
              { col: 16, v: 'M (m)' },
              { col: 19, v: '129', t: 'n' }, // numeric price cell (no t attr)
            ],
          },
          {
            r: 9,
            cells: [
              { col: 1, v: 'AIREON-PANT-NERO-NEO-MEN-XS' }, { col: 2, v: 'PANTS' },
              { col: 3, v: 'Elimina' }, { col: 4, v: 'Bambino' }, { col: 5, v: 'AIREON' },
            ],
          },
          // stray row: 1 filled non-SKU cell → skipped as noise
          { r: 10, cells: [{ col: 7, v: 'nota' }] },
          { r: 11, cells: [] },
        ],
      },
      { name: 'Valori validi', rows: [{ r: 1, cells: [{ col: 1, v: 'Valori' }] }] },
    ],
  })
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('detectAmazonTemplate — v2 grammar', () => {
  it('picks the Modello sheet (not the Definizioni dati trap), reads meta + rows', async () => {
    const bytes = await buildV2Fixture()
    const parsed = await detectAmazonTemplate(bytes)
    expect(parsed).not.toBeNull()
    const p = parsed!
    expect(p.meta.grammar).toBe('v2')
    expect(p.meta.sheet).toBe('Modello')
    expect(p.meta.attrRow).toBe(5)
    expect(p.meta.dataStartRow).toBe(7)
    expect(p.meta.templateIdentifier).toBe('a0fb4d0d-test')
    expect(p.meta.headerLanguageTag).toBe('it_IT')
    expect(p.meta.primaryMarketplaceId).toBe('APJ6JRA9NG5V4')
    expect(p.meta.marketplace).toBe('IT')
    expect(p.meta.productTypes).toEqual(['COAT', 'PANTS'])
    expect(p.headers).toEqual(V2_ATTRS)
    expect(p.labels['contribution_sku#1.value']).toBe('SKU')
    expect(p.rows).toHaveLength(3) // parent + child + delete-child; stray rows skipped
    expect(p.meta.skippedEmptyRows).toBeGreaterThanOrEqual(1)
  })

  it('resolves shared strings, numeric cells, and XML entities', async () => {
    const p = (await detectAmazonTemplate(await buildV2Fixture()))!
    const [parent, child, del] = p.rows
    expect(parent['contribution_sku#1.value']).toBe('AIREON')
    expect(parent[`item_name[marketplace_id=${MP}][language_tag=it_IT]#1.value`]).toBe(
      'Giacca Moto Uomo & Donna',
    )
    expect(child['contribution_sku#1.value']).toBe('AIREON-JACKET-CREMA-E-VINO-MEN-M')
    expect(child[`purchasable_offer[marketplace_id=${MP}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`]).toBe('129')
    expect(del['contribution_sku#1.value']).toBe('AIREON-PANT-NERO-NEO-MEN-XS')
  })

  it('classifies per-row __action and builds the histogram', async () => {
    const p = (await detectAmazonTemplate(await buildV2Fixture()))!
    expect(p.rows.map((r) => r.__action)).toEqual(['replace', 'partial', 'delete'])
    expect(p.meta.actions).toEqual({ replace: 1, partial: 1, delete: 1, unknown: 0 })
  })

  it('normalizes ABSOLUTE /xl/… worksheet rel targets (real DE/ES/FR quirk)', async () => {
    const bytes = await buildWorkbook({
      absoluteRels: true,
      sheets: [
        {
          name: 'Vorlage',
          rows: [
            { r: 1, cells: [{ col: 1, v: SETTINGS_IT.replace('APJ6JRA9NG5V4', 'A1PA6795UKMFR9').replace('it_IT', 'de_DE') }] },
            attrRowSpec(5),
            { r: 7, cells: [{ col: 1, v: 'SKU-1' }, { col: 2, v: 'COAT' }] },
          ],
        },
      ],
    })
    const p = (await detectAmazonTemplate(bytes))!
    expect(p.meta.marketplace).toBe('DE')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0].__action).toBe('replace') // blank action = template default
  })
})

describe('detectAmazonTemplate — legacy grammar + non-templates', () => {
  it('recognizes a legacy fptcustom sheet (item_sku ids on row 3)', async () => {
    const ids = [
      'item_sku', 'feed_product_type', 'brand_name', 'item_name', 'external_product_id',
      'external_product_id_type', 'standard_price', 'quantity', 'main_image_url', 'parent_child',
      'parent_sku', 'relationship_type', 'variation_theme', 'color_name', 'size_name',
      'bullet_point1', 'bullet_point2', 'bullet_point3', 'generic_keywords', 'update_delete',
    ]
    const bytes = await buildWorkbook({
      sheets: [
        {
          name: 'Template',
          rows: [
            { r: 1, cells: [{ col: 1, v: 'TemplateType=fptcustom' }, { col: 2, v: 'Version=2014.0703' }] },
            { r: 2, cells: [{ col: 1, v: 'SKU del venditore' }, { col: 2, v: 'Tipo di prodotto' }] },
            { r: 3, cells: ids.map((v, i) => ({ col: i + 1, v })) },
            { r: 4, cells: [{ col: 1, v: 'GALE-JACKET-BLACK-MEN-M' }, { col: 2, v: 'outerwear' }, { col: 20, v: 'Update' }] },
          ],
        },
      ],
    })
    const p = (await detectAmazonTemplate(bytes))!
    expect(p.meta.grammar).toBe('legacy')
    expect(p.meta.attrRow).toBe(3)
    expect(p.headers[0]).toBe('item_sku')
    expect(p.rows).toHaveLength(1)
    expect(p.meta.productTypes).toEqual(['OUTERWEAR'])
  })

  it('returns null for an ordinary spreadsheet and for non-zip bytes', async () => {
    const ordinary = await buildWorkbook({
      sheets: [
        {
          name: 'Sheet1',
          rows: [
            { r: 1, cells: [{ col: 1, v: 'Name' }, { col: 2, v: 'Price' }] },
            { r: 2, cells: [{ col: 1, v: 'Widget' }, { col: 2, v: '9.99', t: 'n' }] },
          ],
        },
      ],
    })
    expect(await detectAmazonTemplate(ordinary)).toBeNull()
    expect(await detectAmazonTemplate(new TextEncoder().encode('just,a,csv\n1,2,3'))).toBeNull()
  })
})

describe('classifyRecordAction', () => {
  it('maps localized tokens across all four markets + English', () => {
    // delete
    for (const v of ['Elimina', 'Löschen', 'Supprimer', 'Borrar', 'Delete']) {
      expect(classifyRecordAction(v)).toBe('delete')
    }
    // partial update
    for (const v of [
      'Modifica (aggiornamento parziale)',
      'Update (partial update)',
      'Teilweise Aktualisierung',
      'Mise à jour partielle',
      'Actualización parcial',
    ]) {
      expect(classifyRecordAction(v)).toBe('partial')
    }
    // create / replace (incl. blank = template default)
    for (const v of [
      '', '  ',
      '(Impostazione predefinita) Crea o sostituisci',
      'Erstellen oder Ersetzen',
      'Créer ou remplacer',
      'Crear o reemplazar',
      'Create or replace',
    ]) {
      expect(classifyRecordAction(v)).toBe('replace')
    }
    expect(classifyRecordAction('???')).toBe('unknown')
  })
})

describe('decodeXml', () => {
  it('decodes named + numeric entities', () => {
    expect(decodeXml('Uomo &amp; Donna &#8217; &#x27;')).toBe("Uomo & Donna ’ '")
    expect(decodeXml('no entities')).toBe('no entities')
  })
})

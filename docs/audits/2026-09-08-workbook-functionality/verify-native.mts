import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import ExcelJS from '/Users/awais/nexus-commerce/node_modules/exceljs/excel.js'
import JSZip from '/Users/awais/nexus-commerce/node_modules/jszip/lib/index.js'
import { readCatalogWorkbook } from '/Users/awais/nexus-commerce/apps/api/src/services/pim/catalog-workbook.ts'

const baseline = JSON.parse(await fs.readFile('/tmp/nexus-gale-functional-baseline.json', 'utf8'))
const source = '/Users/awais/nexus-commerce/outputs/gale-workbook-functionality-2026-09-08/GALE-JACKET-functional-example.xlsx'
const native = '/tmp/nexus-workbook-format/native-functional/GALE-JACKET-functional-example.xlsx'
const original = new ExcelJS.Workbook(); await original.xlsx.readFile(source)
const book = new ExcelJS.Workbook(); await book.xlsx.readFile(native)
const parsed = readCatalogWorkbook(book, baseline)!
assert.deepEqual(parsed.issues, [])
const stable = (r: any) => JSON.stringify([r.entity, r.sku, r.channel, r.accountId, r.marketplace, r.aliasKey, r.locale, r.field, r.action, r.value, r.version])
assert.deepEqual(parsed.rows.map(stable).sort(), baseline.scopes.flatMap((s: any) => s.rows).map(stable).sort())
const zip = await JSZip.loadAsync(await fs.readFile(native))
for (const name of ['Valid values', 'Dictionary', 'Nexus workbook']) {
  const sheet = book.getWorksheet(name)!
  const xml = await zip.file(`xl/worksheets/sheet${sheet.id}.xml`)!.async('string')
  assert.match(xml, /<sheetProtection[^>]+sheet="(?:true|1)"/)
  if (name !== 'Nexus workbook') assert.ok(sheet.autoFilter)
}
let dropdowns = 0
for (const scope of baseline.scopes) {
  const sheet = book.getWorksheet(scope.sheet)!, before = original.getWorksheet(scope.sheet)!
  assert.ok(sheet.autoFilter)
  assert.ok(Math.abs(sheet.getRow(2).height - before.getRow(2).height) < 1, 'Native row-height rounding stays below one point')
  assert.equal(sheet.views[0].state, 'frozen')
  before.eachRow((row, index) => {
    if (index === 1) return
    row.eachCell((cell, c) => {
      const name = cell.dataValidation?.formulae?.[0]
      if (!name?.startsWith('NexusValues_')) return
      const validation = sheet.getCell(index, c).dataValidation
      assert.equal(validation.type, 'list')
      assert.deepEqual(book.definedNames.getRanges(validation.formulae[0]).ranges, original.definedNames.getRanges(name).ranges)
      dropdowns++
    })
  })
}
assert.ok(dropdowns)
const report = { application: 'LibreOffice 26.2.4.2', nativeSave: native, attributesPreserved: parsed.rows.length, dropdownsPreserved: dropdowns, referenceProtection: true, headerFilters: true, compactRows: true }
await fs.writeFile('/Users/awais/nexus-commerce/outputs/gale-workbook-functionality-2026-09-08/native-verification.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))

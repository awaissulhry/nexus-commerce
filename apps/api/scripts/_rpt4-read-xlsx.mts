import ExcelJS from 'exceljs'
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(process.argv[2])
console.log('sheets:', wb.worksheets.map(w => `"${w.name}" (${w.rowCount}r × ${w.columnCount}c)`).join('  '))
const d = wb.getWorksheet('Data')!
console.log('\n--- Data: header ---'); console.log((d.getRow(1).values as unknown[]).slice(1).join(' | '))
console.log('--- Data: row 2 (types + numFmt) ---')
d.getRow(2).eachCell((c, i) => console.log(`  col${i} ${d.getColumn(i).numFmt.padEnd(9)} ${typeof c.value} = ${JSON.stringify(c.value)}`))
console.log('--- Data: last row (TOTAL) ---'); console.log((d.getRow(d.rowCount).values as unknown[]).slice(1).join(' | '))
console.log('\n--- About this export ---')
const a = wb.getWorksheet('About this export')!
a.eachRow((r, i) => { if (i <= 34) console.log('  ' + (r.values as unknown[]).slice(1).map(v => String(v ?? '')).join('  │  ')) })

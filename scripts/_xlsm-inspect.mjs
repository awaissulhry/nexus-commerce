import ExcelJS from 'exceljs'
const file = process.argv[2]
const wb = new ExcelJS.Workbook()
try { await wb.xlsx.readFile(file) } catch (e) { console.error('read failed:', e.message); process.exit(1) }
console.log('SHEETS:', wb.worksheets.map(w => `${w.name}(${w.rowCount}x${w.columnCount})`).join(' | '))
// find the data sheet: the one with the most rows (usually Template/Modello)
const dataSheet = wb.worksheets.slice().sort((a,b)=>b.rowCount-a.rowCount)[0]
console.log('\nDATA SHEET:', dataSheet.name, `rows=${dataSheet.rowCount}`)
const rowVals = (r) => { const a=[]; dataSheet.getRow(r).eachCell({includeEmpty:true},(c,n)=>{a[n-1]=c.text}); return a }
for (let r=1; r<=4; r++) {
  const v = rowVals(r).map(x=>x??'')
  console.log(`\nROW ${r} (${v.filter(Boolean).length} non-empty):`, JSON.stringify(v.slice(0,25)))
}
console.log('\n--- first 2 data rows (guessing data starts ~row 4/5) ---')
for (let r=4; r<=6; r++) {
  const v = rowVals(r).map(x=>x??'')
  if (v.filter(Boolean).length > 2) console.log(`ROW ${r}:`, JSON.stringify(v.slice(0,20)))
}

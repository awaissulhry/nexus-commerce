// Fast Amazon flat-file template parser: extracts ONLY the "Modello" (Template)
// sheet + sharedStrings from an .xlsm/.xlsx, returns rows keyed by technical
// field name (row 3). Read-only.
import { execSync } from 'child_process'
const file = process.argv[2]
const mode = process.argv[3] ?? 'inspect'
const unzip = (entry) => execSync(`unzip -p "${file}" "${entry}"`, { maxBuffer: 1<<30 }).toString('utf8')

// 1. find Modello sheet target
const wb = unzip('xl/workbook.xml')
const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)].map(m => ({ name: m[1], rid: m[2] }))
const rels = unzip('xl/_rels/workbook.xml.rels')
const relMap = Object.fromEntries([...rels.matchAll(/<Relationship [^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)].map(m => [m[1], m[2]]))
const modello = sheets.find(s => /^(Modello|Template|Vorlage|Modelo|Mod..le|Plantilla)$/i.test(s.name.trim())) ?? sheets.find(s=>/modello|template/i.test(s.name)) ?? sheets[0]
const target = relMap[modello.rid].replace(/^\/?/, 'xl/').replace('xl/worksheets','xl/worksheets')
const sheetPath = relMap[modello.rid].startsWith('/') ? relMap[modello.rid].slice(1) : 'xl/' + relMap[modello.rid]

// 2. shared strings
const ss = unzip('xl/sharedStrings.xml')
const strings = [...ss.matchAll(/<si>(.*?)<\/si>/gs)].map(m => {
  const inner = m[1]
  return [...inner.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(t => t[1]).join('')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#10;/g,'\n').replace(/&apos;/g,"'")
})

// 3. sheet rows
const sheet = unzip(sheetPath)
const colToNum = (c) => { let n=0; for (const ch of c) n=n*26+(ch.charCodeAt(0)-64); return n-1 }
const rows = []
for (const rm of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
  const rIdx = +rm[1]; const cells = []
  for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs)) {
    const col = colToNum(cm[1]); const t = cm[2]; let val = cm[3] ?? cm[4] ?? ''
    if (t === 's') val = strings[+val] ?? ''
    else val = String(val).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#10;/g,'\n')
    cells[col] = val
  }
  rows[rIdx] = cells
}
console.log(`SHEET=${modello.name}  path=${sheetPath}  strings=${strings.length}  rows=${rows.length}`)

if (mode === 'inspect') {
  for (let r=1; r<=4; r++) {
    const v = (rows[r]??[]).map(x=>x??'')
    console.log(`\nROW ${r} (${v.filter(Boolean).length} non-empty):`)
    console.log(JSON.stringify(v.slice(0,30)))
  }
  // find a data row
  for (let r=4; r<=8; r++){ const v=(rows[r]??[]).map(x=>x??''); if(v.filter(Boolean).length>3){ console.log(`\nDATA ROW ${r}:`, JSON.stringify(v.slice(0,15))); break } }
}

if (mode === 'dumprows') {
  const which = (process.argv[4] ?? '5,6,7').split(',').map(Number)
  for (const r of which) {
    const cells = rows[r] ?? []
    const nonEmpty = []
    cells.forEach((v, i) => { if (v != null && String(v).trim() !== '') nonEmpty.push(`[${i}]${String(v).slice(0,28)}`) })
    console.log(`\nROW ${r} (${nonEmpty.length} cells):`)
    console.log(nonEmpty.slice(0, 60).join('  '))
  }
}

'use client'

/**
 * Amazon-Ads-faithful Bulk operations screen.
 *  • Download — current Campaign/Ad-group/Keyword/Target state as a real .xlsx
 *    bulksheet in Amazon's exact column layout (GET /advertising/bulk/export).
 *  • Upload — parse an .xlsx (exceljs) or .csv bulksheet client-side, validate
 *    every row against the bulksheet grammar (Product / Entity / Operation +
 *    per-entity required fields), and preview what would change. Applying the
 *    sheet (Create/Update/Archive via the gated write paths) lands in Phase M.
 */

import { useCallback, useRef, useState } from 'react'
import ExcelJS from 'exceljs'
import { Download, Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Row = Record<string, string>
interface VRow { r: Row; ok: boolean; op: string; msg: string }

const ENTITIES = ['Campaign', 'Ad group', 'Keyword', 'Product ad', 'Product targeting', 'Negative keyword', 'Bidding adjustment', 'Portfolio']
const OPS = ['Create', 'Update', 'Archive']

const cellStr = (v: unknown): string => {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('')
    if (o.result != null) return String(o.result)
    if (o.hyperlink != null) return String(o.text ?? o.hyperlink)
    return ''
  }
  return String(v)
}

const splitCsv = (line: string): string[] => {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch } else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = '' } else cur += ch }
  }
  out.push(cur); return out
}

export function BulkOpsClient() {
  const [rows, setRows] = useState<VRow[]>([])
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const validateRow = (r: Row): { ok: boolean; op: string; msg: string } => {
    const g = (k: string) => (r[k] ?? '').toString().trim()
    const entity = g('Entity'); const op = g('Operation')
    const ok = (m: string) => ({ ok: true, op: op || 'Read', msg: m })
    const bad = (m: string) => ({ ok: false, op: op || 'Read', msg: m })
    if (!entity) return bad('Missing Entity')
    if (!ENTITIES.includes(entity)) return bad(`Unknown Entity “${entity}”`)
    if (op && !OPS.includes(op)) return bad(`Operation must be Create/Update/Archive (got “${op}”)`)
    if (!op) return ok('Read — no change')
    switch (entity) {
      case 'Campaign':
        if (op === 'Create') { if (!g('Campaign name')) return bad('Campaign name required'); if (!g('Daily budget') && !g('Budget')) return bad('Daily budget required') } else if (!g('Campaign ID')) return bad('Campaign ID required')
        break
      case 'Ad group':
        if (op === 'Create') { if (!g('Ad group name')) return bad('Ad group name required'); if (!g('Campaign ID')) return bad('Campaign ID required') } else if (!g('Ad group ID')) return bad('Ad group ID required')
        break
      case 'Keyword':
      case 'Negative keyword':
        if (op === 'Create') { if (!g('Keyword text')) return bad('Keyword text required'); if (!g('Match type')) return bad('Match type required'); if (!g('Campaign ID') && !g('Ad group ID')) return bad('Campaign ID or Ad group ID required') } else if (!g('Keyword ID')) return bad('Keyword ID required')
        break
      case 'Product targeting':
        if (op === 'Create') { if (!g('Product targeting expression') && !g('Targeting expression')) return bad('Product targeting expression required'); if (!g('Ad group ID')) return bad('Ad group ID required') } else if (!g('Product Targeting ID') && !g('Targeting ID')) return bad('Product Targeting ID required')
        break
      case 'Product ad':
        if (op === 'Create' && !g('SKU') && !g('ASIN')) return bad('SKU or ASIN required')
        break
      case 'Portfolio':
        if (op === 'Create') { if (!g('Portfolio name')) return bad('Portfolio name required') } else if (!g('Portfolio ID')) return bad('Portfolio ID required')
        break
    }
    return ok(`${op} ok`)
  }

  const parseXlsx = async (file: File): Promise<Row[]> => {
    const buf = await file.arrayBuffer()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    if (!ws) return []
    const headers: string[] = []
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = cellStr(cell.value).trim() })
    const out: Row[] = []
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (rn === 1) return
      const o: Row = {}
      row.eachCell({ includeEmpty: true }, (cell, col) => { const h = headers[col]; if (h) o[h] = cellStr(cell.value).trim() })
      if (Object.values(o).some((v) => v !== '')) out.push(o)
    })
    return out
  }

  const parseCsv = (text: string): Row[] => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (!lines.length) return []
    const headers = splitCsv(lines[0]).map((h) => h.trim())
    return lines.slice(1).map((l) => { const c = splitCsv(l); const o: Row = {}; headers.forEach((h, i) => { o[h] = (c[i] ?? '').trim() }); return o }).filter((o) => Object.values(o).some((v) => v !== ''))
  }

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setErr(null); setFileName(file.name); setRows([])
    try {
      const raw = /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : await parseXlsx(file)
      const MAX = 2000
      setTruncated(raw.length > MAX)
      setRows(raw.slice(0, MAX).map((r) => { const v = validateRow(r); return { r, ...v } }))
    } catch (e) { setErr((e as Error)?.message ?? 'Could not parse file') } finally { setParsing(false) }
  }, [])

  const keyField = (r: Row) => r['Campaign name'] || r['Ad group name'] || r['Keyword text'] || r['Product targeting expression'] || r['Portfolio name'] || r['Campaign ID'] || '—'
  const exportHref = `${getBackendUrl()}/api/advertising/bulk/export?limit=500`

  const counts = { Create: 0, Update: 0, Archive: 0, Read: 0, errors: 0 }
  for (const v of rows) { if (!v.ok) counts.errors++; const k = v.op as keyof typeof counts; if (k in counts && k !== 'errors') counts[k]++ }

  return (
    <div className="az-wrap">
      <div className="az-listhead"><span className="title">Bulk operations</span><span style={{ flex: 1 }} /></div>

      <div className="az-bulk">
        <div className="az-card">
          <h3><Download size={16} style={{ marginRight: 6 }} />Download bulksheet</h3>
          <p className="desc">Export your current campaigns, ad groups, keywords and product targets as a real Excel bulksheet in Amazon’s exact column layout. Edit it in Excel, then upload it here.</p>
          <a className="az-btn dark" href={exportHref}><Download size={15} />Download current state (.xlsx)</a>
        </div>

        <div className="az-card">
          <h3><Upload size={16} style={{ marginRight: 6 }} />Upload &amp; validate</h3>
          <p className="desc">Drop an edited .xlsx or .csv bulksheet to validate every row against Amazon’s grammar (Entity · Operation · required fields) and preview what would change.</p>
          <label
            className={`az-drop ${over ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f) }}
            onClick={() => inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept=".xlsx,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }} />
            <FileSpreadsheet size={26} style={{ marginBottom: 6 }} />
            <div>{parsing ? 'Parsing…' : fileName ? <>Loaded <span className="fn">{fileName}</span> — drop another to replace</> : <>Drag a bulksheet here, or <span className="fn">browse</span></>}</div>
          </label>
          {err && <div className="az-rowstat err" style={{ marginTop: 10 }}><AlertCircle size={14} />{err}</div>}
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="az-sum">
            <span className="chip"><b>{rows.length}</b> rows{truncated ? ' (first 2,000)' : ''}</span>
            {counts.Create > 0 && <span className="chip create"><b>{counts.Create}</b> create</span>}
            {counts.Update > 0 && <span className="chip"><b>{counts.Update}</b> update</span>}
            {counts.Archive > 0 && <span className="chip"><b>{counts.Archive}</b> archive</span>}
            {counts.Read > 0 && <span className="chip"><b>{counts.Read}</b> read</span>}
            <span className={`chip ${counts.errors ? 'err' : ''}`}><b>{counts.errors}</b> errors</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button className="az-btn dark" disabled title="Applying changes ships in the next release" style={{ opacity: .5, cursor: 'not-allowed' }}>Apply changes</button>
            <span className="az-rowstat" style={{ color: 'var(--ink2)' }}><Info size={13} />Validation only — applying (Create/Update/Archive via the gated write paths) ships next.</span>
          </div>

          <div className="az-tablewrap">
            <table className="az-table">
              <thead><tr>
                <th className="l" style={{ width: 44 }}>#</th>
                <th className="l">Product</th><th className="l">Entity</th><th className="l">Operation</th>
                <th className="l">Campaign / item</th><th className="l">Match</th><th>Bid / Budget</th>
                <th className="l">Status</th>
              </tr></thead>
              <tbody>
                {rows.map((v, i) => (
                  <tr key={i}>
                    <td className="l sub">{i + 1}</td>
                    <td className="l">{v.r['Product'] || '—'}</td>
                    <td className="l"><span className="az-pill">{v.r['Entity'] || '—'}</span></td>
                    <td className="l">{v.r['Operation'] ? <span className="az-pill">{v.r['Operation']}</span> : <span className="sub">read</span>}</td>
                    <td className="l">{keyField(v.r)}</td>
                    <td className="l">{v.r['Match type'] || '—'}</td>
                    <td className="num">{v.r['Bid'] || v.r['Daily budget'] || v.r['Budget'] || '—'}</td>
                    <td className="l">{v.ok ? <span className="az-rowstat ok"><CheckCircle2 size={14} />{v.msg}</span> : <span className="az-rowstat err"><AlertCircle size={14} />{v.msg}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

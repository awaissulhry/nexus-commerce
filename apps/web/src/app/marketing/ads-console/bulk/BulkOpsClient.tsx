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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import ExcelJS from 'exceljs'
import { Download, Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Info, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { validateRow as validateBulksheetRow } from '@nexus/shared/ads-bulksheet'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignHref } from '../automation/useCampaignMap'
import { useAmazonLinks, buildAmazonCampaignHref } from '../automation/useAmazonLinks'

type Row = Record<string, string>
interface VRow { r: Row; ok: boolean; op: string; msg: string }

// AX-IE.11 — the entity and operation lists that used to live here are gone.
// They were the second grammar the shared schema was built to end, and they had
// already drifted: no Campaign negative keyword, no Negative product targeting,
// no ad-product legality check, no it-IT aliases. Validation now comes from
// `@nexus/shared/ads-bulksheet`, the same module the server validates with.

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

interface BidHistoryItem {
  id: string; entityType: string; entityId: string; campaignId: string | null
  field: string; oldValue: string | null; newValue: string | null
  changedAt: string; changedBy: string; reason: string | null
  campaign?: { id: string; name: string; marketplace: string | null; externalCampaignId: string | null }
}

const eur = (v: string | null) => { const n = Number(v); return isNaN(n) ? v ?? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(n) }
const relTime = (iso: string) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago` }

export function BulkOpsClient() {
  const searchParams = useSearchParams()
  const tab = (searchParams.get('tab') ?? 'download') as 'download' | 'upload' | 'diff'
  const [rows, setRows] = useState<VRow[]>([])
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  // Automation diff state
  const [diffItems, setDiffItems] = useState<BidHistoryItem[] | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const profileMap = useAmazonLinks()

  const loadDiff = async () => {
    setDiffLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/bid-history?limit=200`, { cache: 'no-store' }).then(r => r.json())
      // Only show automation-driven changes
      const auto = (d.items ?? []).filter((i: BidHistoryItem) => i.changedBy?.startsWith('automation:'))
      // Enrich with campaign name/marketplace via a campaigns fetch (best-effort)
      const campRes = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then(r => r.json()).catch(() => ({ items: [] }))
      const campMap: Record<string, { id: string; name: string; marketplace: string | null; externalCampaignId: string | null }> = {}
      for (const c of (campRes.items ?? [])) campMap[c.id] = c
      setDiffItems(auto.map((i: BidHistoryItem) => ({ ...i, campaign: i.campaignId ? campMap[i.campaignId] : undefined })))
    } finally { setDiffLoading(false) }
  }

  useEffect(() => { if (tab === 'diff' && diffItems === null) void loadDiff() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * One grammar. `validateRow` is the shared, server-identical checker, so this
   * page can no longer accept a row the server would reject — or reject one it
   * would take.
   */
  const validateRow = (r: Row): { ok: boolean; op: string; msg: string } => {
    const v = validateBulksheetRow((h) => (r[h] ?? '').toString())
    const op = v.operation ?? 'Read'
    if (!v.ok) return { ok: false, op, msg: v.issues.map((i) => i.message).join('; ') || 'Invalid row' }
    if (v.readOnly) return { ok: true, op: 'Read', msg: 'Read — no change' }
    if (v.previewOnly) return { ok: true, op, msg: `${op} — previews only, not applied` }
    return { ok: true, op, msg: `${op} ok` }
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
      <div className="az-listhead">
        <span className="title"><FileSpreadsheet size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Bulk operations</span>
        <span style={{ flex: 1 }} />
      </div>

      {/* Automation diff tab */}
      {tab === 'diff' && (
        <div>
          <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 14 }}>
            Every bid / budget / status change made by automation rules — who changed what, why, and which campaign it touched. Use this to audit what automation has done before going fully live.
          </div>
          {diffLoading && <div className="az-empty">Loading automation changes...</div>}
          {!diffLoading && diffItems?.length === 0 && <div className="az-empty" style={{ border: '1px solid var(--divider)', borderRadius: 10 }}>No automation-driven changes yet. Enable a rule and let it fire.</div>}
          {!diffLoading && (diffItems ?? []).length > 0 && (
            <div className="az-tablewrap">
              <table className="az-table">
                <thead><tr>
                  <th className="l">Rule</th><th className="l">Campaign</th><th className="l">Field</th><th>Before</th><th>After</th><th className="l">Reason</th><th className="l">When</th>
                </tr></thead>
                <tbody>
                  {(diffItems ?? []).map(item => {
                    const c = item.campaign
                    const mkt = c?.marketplace
                    const amzHref = c?.externalCampaignId && mkt ? buildAmazonCampaignHref(c.externalCampaignId, mkt, profileMap) : null
                    const ruleId = item.changedBy?.replace('automation:', '')
                    const isBid = item.field === 'bid' || item.field === 'dailyBudget' || item.field === 'defaultBid'
                    return (
                      <tr key={item.id}>
                        <td className="l"><span className="sub" style={{ fontSize: 10.5 }}>{ruleId?.slice(0, 12)}...</span></td>
                        <td className="l">
                          {c ? <a className="cn" href={campaignHref(c.id)} target="_blank" rel="noopener noreferrer">{c.name}</a> : <span className="sub">{item.campaignId ?? item.entityId.slice(0, 12)}</span>}
                          {amzHref && <><br /><a href={amzHref} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--link)', fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>Amazon <ExternalLink size={9} /></a></>}
                          {mkt && <span className="az-badge" style={{ marginLeft: 4 }}>{mkt}</span>}
                        </td>
                        <td className="l" style={{ fontWeight: 600 }}>{item.field}</td>
                        <td className="num" style={{ color: 'var(--ink2)' }}>{isBid ? eur(item.oldValue) : item.oldValue ?? '—'}</td>
                        <td className="num" style={{ fontWeight: 700, color: 'var(--green)' }}>{isBid ? eur(item.newValue) : item.newValue ?? '—'}</td>
                        <td className="l"><span className="sub">{item.reason ?? '—'}</span></td>
                        <td className="l"><span className="sub" title={new Date(item.changedAt).toLocaleString()}>{relTime(item.changedAt)}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Original download + upload panels (now tab-gated) */}
      {(tab === 'download' || tab === 'upload') && (<>
        <div className="az-bulk">
          <div className="az-card">
            <h3><Download size={16} style={{ marginRight: 6 }} />Download bulksheet</h3>
            <p className="desc">Export your current campaigns, ad groups, keywords and product targets as a real Excel bulksheet in Amazon's exact column layout. Edit it in Excel, then upload it here.</p>
            <a className="az-btn dark" href={exportHref}><Download size={15} />Download current state (.xlsx)</a>
          </div>

          <div className="az-card">
            <h3><Upload size={16} style={{ marginRight: 6 }} />Upload &amp; validate</h3>
            <p className="desc">Drop an edited .xlsx or .csv bulksheet to validate every row against Amazon's grammar (Entity · Operation · required fields) and preview what would change.</p>
            <label
              className={`az-drop ${over ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f) }}
              onClick={() => inputRef.current?.click()}
            >
              <input ref={inputRef} type="file" accept=".xlsx,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }} />
              <FileSpreadsheet size={26} style={{ marginBottom: 6 }} />
              <div>{parsing ? 'Parsing...' : fileName ? <>Loaded <span className="fn">{fileName}</span> — drop another to replace</> : <>Drag a bulksheet here, or <span className="fn">browse</span></>}</div>
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

          {(() => {
            const actionable = rows.filter((v) => v.ok && v.op !== 'Read').length
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {/* AX-IE.11 — this used to apply the file from here, through a
                      path with no preview, no blast-radius check and no undo.
                      Validation still runs, so this page remains useful for
                      checking a file; the write now happens where it can be
                      seen first and reverted afterwards. */}
                  <Link href="/marketing/ads/bulk" className="az-btn dark">
                    Apply {actionable} change{actionable === 1 ? '' : 's'} in Bulk operations
                  </Link>
                  <span className="az-rowstat" style={{ color: 'var(--ink2)' }}><Info size={13} />Applying moved to Bulk operations, where you see the exact before/after and can undo the whole upload. This page still validates a file.</span>
                </div>
              </div>
            )
          })()}

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
      </>)}
    </div>
  )
}

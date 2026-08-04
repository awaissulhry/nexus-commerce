'use client'

/**
 * RPT.15 — the public view of a shared report.
 *
 * Rendered for someone with no account, so it shows the table and nothing else
 * about us: no sidebar, no navigation, no links back into the console, no hint
 * of what other reports exist.
 *
 * The fetch is client-side on purpose. A server component would run the request
 * from the server with no browser cookies and fail the auth-sensitive path that
 * every other surface here already learned the hard way — and this endpoint is
 * public anyway, so there is nothing to gain from server rendering.
 *
 * Every failure — unknown, expired, revoked — is shown with the SAME wording the
 * API returns, because distinguishing them would confirm to someone guessing
 * tokens that one had existed.
 */
import { useEffect, useState } from 'react'
import { use } from 'react'
import { AlertTriangle } from 'lucide-react'
import { fetchSharedReport } from '@/app/marketing/ads/reporting/shares-api'
import './shared-report.css'

type Data = Awaited<ReturnType<typeof fetchSharedReport>>

const fmt = (v: unknown, format?: string) => {
  if (v == null) return '—'
  if (typeof v === 'number') {
    if (format === 'money') return `€${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (format === 'pct') return `${(v * 100).toFixed(2)}%`
    if (format === 'ratio') return v.toFixed(2)
    return v.toLocaleString()
  }
  return String(v)
}

export default function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    fetchSharedReport(token, ctl.signal)
      .then(setData)
      .catch((e) => { if (e.name !== 'AbortError') setErr(String(e.message ?? e)) })
    return () => ctl.abort()
  }, [token])

  if (err) {
    return (
      <div className="shr-wrap">
        <div className="shr-empty" role="alert">
          <AlertTriangle size={20} aria-hidden />
          <h1>{err}</h1>
          <p>Ask whoever sent it for a new link.</p>
        </div>
      </div>
    )
  }

  if (!data) {
    return <div className="shr-wrap"><div className="shr-empty"><p>Loading…</p></div></div>
  }

  const { result } = data
  return (
    <div className="shr-wrap">
      <header className="shr-head">
        <h1>{data.label || data.title}</h1>
        <p>
          {result.total.toLocaleString()} row{result.total === 1 ? '' : 's'}
          {' · '}read-only{' · '}link expires {data.expiresAt.slice(0, 10)}
        </p>
      </header>

      <div className="shr-tablewrap">
        <table className="shr-table">
          <thead>
            <tr>{result.columns.map((c) => (
              <th key={c.id} className={c.align === 'right' ? 'num' : undefined}>{c.label}</th>
            ))}</tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {result.columns.map((c) => (
                  <td key={c.id} className={c.align === 'right' ? 'num' : undefined}>
                    {fmt(row[c.id], c.format)}
                  </td>
                ))}
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr><td colSpan={result.columns.length}>No rows in this window.</td></tr>
            )}
          </tbody>
          {result.totals && (
            <tfoot>
              <tr>
                {result.columns.map((c, i) => (
                  <td key={c.id} className={c.align === 'right' ? 'num' : undefined}>
                    {i === 0 ? 'Total' : fmt((result.totals as Record<string, unknown>)[c.id], c.format)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Deliberately no link back into the console. */}
      <footer className="shr-foot">Shared from Nexus · read-only</footer>
    </div>
  )
}

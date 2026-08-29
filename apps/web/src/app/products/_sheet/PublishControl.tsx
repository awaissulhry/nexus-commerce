'use client'

/**
 * MS.5 — publish, preflight-first.
 *
 * `docs/2026-08-29-master-sheet-design.md` §13. Publishing is outward-facing and hard to reverse, so
 * nothing leaves this component as a side effect of one click. The flow is deliberately two steps:
 *
 *   1. **Preview** — asks the server what would happen to each selected row. No channel call. Rows
 *      whose readiness has errors are refused here, with the missing fields named.
 *   2. **Send** — a separate button that appears only after the preview, states exactly how many
 *      rows it will send and to where, and defaults to a DRY RUN.
 *
 * The platform's own gate (`AMAZON_PUBLISH_MODE`) defaults to dry-run too, so a live send needs both
 * this switch and that env. The banner says which mode is really in force: a green result in dry-run
 * mode means "this would have worked", never "this is listed", and conflating the two is the whole
 * reason the step exists.
 */
import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Send, ShieldCheck } from 'lucide-react'

import { Button, Checkbox, Pill } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

import type { SheetCoordinate, SheetRow } from './types'

export type PublishVerdict = 'ready' | 'warned' | 'unlisted' | 'blocked'

export interface PublishPreviewRow {
  id: string
  sku: string
  name: string | null
  isParent: boolean
  verdict: PublishVerdict
  issues: Array<{ key: string; label: string; message: string; severity: 'error' | 'warn' }>
  ref?: string
}

export interface PublishPreview {
  channel: string
  marketplace: string
  coordinate: string
  rows: PublishPreviewRow[]
  summary: { total: number; sendable: number; blocked: number; unlisted: number; warned: number }
  publishMode: string
  notSendable?: string
}

export interface SendOutcome {
  id: string
  sku: string
  ok: boolean
  dryRun: boolean
  message: string
}

export interface PublishControlProps {
  rows: SheetRow[]
  coordinates: SheetCoordinate[]
  onDone?: () => void
}

export function PublishControl({ rows, coordinates, onDone }: PublishControlProps) {
  const [coord, setCoord] = useState<SheetCoordinate | null>(null)
  const [preview, setPreview] = useState<PublishPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [outcomes, setOutcomes] = useState<SendOutcome[] | null>(null)

  const ids = useMemo(() => rows.map((r) => r.id), [rows])

  const runPreview = useCallback(async (c: SheetCoordinate) => {
    setCoord(c); setBusy(true); setError(null); setPreview(null); setOutcomes(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/sheet/publish-preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, channel: c.channel, marketplace: c.marketplace }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      setPreview(body as PublishPreview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ids])

  /** The real send — per row, on the route that already owns publishing, one at a time. */
  const send = useCallback(async () => {
    if (!preview || !coord) return
    const sendable = preview.rows.filter((r) => r.verdict !== 'blocked')
    setBusy(true); setError(null)
    const results: SendOutcome[] = []
    for (const row of sendable) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/products/${row.id}/publish-amazon`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketplaces: [coord.marketplace], dryRun }),
        })
        const body = await res.json().catch(() => null)
        const first = Array.isArray(body?.results) ? body.results[0] : Array.isArray(body) ? body[0] : body
        results.push({
          id: row.id,
          sku: row.sku,
          ok: res.ok && first?.ok !== false,
          dryRun: first?.dryRun ?? dryRun,
          message: first?.error || body?.error || (first?.feedId ? `feed ${first.feedId}` : res.ok ? 'accepted' : `HTTP ${res.status}`),
        })
      } catch (err) {
        results.push({ id: row.id, sku: row.sku, ok: false, dryRun, message: err instanceof Error ? err.message : String(err) })
      }
    }
    setOutcomes(results)
    setBusy(false)
    onDone?.()
  }, [preview, coord, dryRun, onDone])

  const reset = () => { setCoord(null); setPreview(null); setOutcomes(null); setError(null) }

  if (!coord) {
    return (
      <>
        {coordinates.map((c) => (
          <Button key={`${c.channel}:${c.marketplace}`} size="sm" onClick={() => runPreview(c)} title={`Check what publishing ${rows.length} selected rows to ${c.label} would do`}>
            <Send size={12} /> {c.label}
          </Button>
        ))}
      </>
    )
  }

  const modeIsLive = preview?.publishMode === 'live'
  const sendable = preview?.summary.sendable ?? 0
  const canSend = !!preview && !preview.notSendable && sendable > 0

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong className="text-sm">{coord.label}</strong>

      {busy && !preview && <span className="nds-cell-muted">Checking {ids.length} rows…</span>}
      {error && <Pill tone="danger" size="sm">{error}</Pill>}

      {preview && !outcomes && (
        <>
          {preview.summary.blocked > 0 && (
            <Pill tone="danger" size="sm" title={preview.rows.filter((r) => r.verdict === 'blocked').slice(0, 6).map((r) => `${r.sku}: ${r.issues[0]?.message ?? 'blocked'}`).join('\n')}>
              {preview.summary.blocked} blocked
            </Pill>
          )}
          {sendable > 0 && <Pill tone="success" size="sm">{sendable} sendable</Pill>}
          {preview.summary.unlisted > 0 && <Pill tone="neutral" size="sm" title="Not on the channel yet — this would create the listing">{preview.summary.unlisted} new</Pill>}
          {preview.summary.warned > 0 && <Pill tone="warning" size="sm">{preview.summary.warned} warned</Pill>}

          {preview.notSendable ? (
            <Pill tone="neutral" size="sm" title={preview.notSendable}><AlertTriangle size={11} /> preview only</Pill>
          ) : (
            <>
              {/* A tick that arms a live marketplace write must not look like every other tick. */}
              <Checkbox
                tone={dryRun ? undefined : 'danger'}
                label="Dry run"
                checked={dryRun}
                onChange={(e) => setDryRun(e.currentTarget.checked)}
                title="Rehearse the send without touching the channel. Unticking arms a real publish."
              />
              <Button size="sm" variant={dryRun ? 'secondary' : 'danger'} disabled={!canSend || busy} onClick={send}>
                {dryRun ? <ShieldCheck size={12} /> : <Send size={12} />}
                {busy ? 'Sending…' : dryRun ? `Rehearse ${sendable}` : `Send ${sendable} for real`}
              </Button>
            </>
          )}

          {/* The platform gate can force a dry run whatever this control says — never let a green
              result read as "listed" when nothing left the building. */}
          {preview.publishMode !== 'live' && (
            <Pill tone="neutral" size="sm" title={`${coord.channel}_PUBLISH_MODE is "${preview.publishMode}" — ${preview.publishMode === 'gated' ? 'publishing is switched off for this channel entirely' : 'the platform simulates every send regardless of the switch above'}`}>
              platform: {preview.publishMode}
            </Pill>
          )}
          {modeIsLive && !dryRun && <Pill tone="danger" size="sm">this will really publish</Pill>}
        </>
      )}

      {outcomes && (
        <>
          <Pill tone={outcomes.every((o) => o.ok) ? 'success' : 'danger'} size="sm" title={outcomes.slice(0, 8).map((o) => `${o.sku}: ${o.message}`).join('\n')}>
            {outcomes.filter((o) => o.ok).length}/{outcomes.length} {outcomes[0]?.dryRun ? 'rehearsed' : 'published'}
          </Pill>
          {outcomes.some((o) => !o.ok) && (
            <Pill tone="danger" size="sm" title={outcomes.filter((o) => !o.ok).map((o) => `${o.sku}: ${o.message}`).join('\n')}>
              {outcomes.filter((o) => !o.ok).length} failed
            </Pill>
          )}
        </>
      )}

      <Button size="sm" variant="link" onClick={reset}>Close</Button>
    </span>
  )
}

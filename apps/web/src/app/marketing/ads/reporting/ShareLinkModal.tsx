'use client'

/**
 * RPT.15 — create and manage read-only share links.
 *
 * The token is shown EXACTLY ONCE. The server keeps only a hash and cannot
 * reproduce it, so this dialog is the single moment it exists outside the
 * recipient's URL bar. That is stated plainly rather than left as a surprise,
 * and the new link is presented pre-selected so copying is one action.
 *
 * The link carries the report AS CURRENTLY FILTERED. Anyone holding it sees that
 * data without signing in, so the current window is spelled out before creating
 * one — a share is a disclosure, and the operator should see exactly what they
 * are disclosing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Link2, Trash2 } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import {
  createShareLink, listShareLinks, revokeShareLink, shareUrl, type ShareLink,
} from './shares-api'

const TTL_CHOICES = [1, 7, 30, 90]

export function ShareLinkModal({
  open, onClose, reportId, reportTitle, query,
}: {
  open: boolean
  onClose: () => void
  reportId: string
  reportTitle: string
  /** The live query — frozen server-side at creation. */
  query: Record<string, unknown>
}) {
  const [items, setItems] = useState<ShareLink[]>([])
  const [label, setLabel] = useState('')
  const [ttlDays, setTtlDays] = useState(7)
  const [minted, setMinted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tokenRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    listShareLinks().then(setItems).catch((e) => setErr(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    if (!open) return
    setMinted(null)
    setCopied(false)
    setErr(null)
    reload()
  }, [open, reload])

  const create = async () => {
    setBusy(true)
    setErr(null)
    try {
      const out = await createShareLink({ reportId, query, label: label.trim() || undefined, ttlDays })
      setMinted(shareUrl(out.token))
      setLabel('')
      reload()
      // Pre-select so the operator can copy without hunting for the end of it.
      requestAnimationFrame(() => tokenRef.current?.select())
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked; the field is selected either way.
      tokenRef.current?.select()
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    try {
      await revokeShareLink(id)
      reload()
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const windowLabel = (() => {
    const from = query.from as string | undefined
    const to = query.to as string | undefined
    return from && to ? `${from} → ${to}` : 'all dates'
  })()

  return (
    <Modal open={open} onClose={onClose} title="Share this report" size="lg">
      <div className="rpt-share">
        <p className="rpt-share-lede">
          Anyone with the link can see <b>{reportTitle}</b> for <b>{windowLabel}</b> without
          signing in. The link is read-only — it cannot change filters, run other reports, or
          export.
        </p>

        {err && (
          <div className="rpt-share-err" role="alert">
            <AlertTriangle size={14} aria-hidden /> {err}
          </div>
        )}

        {minted ? (
          <div className="rpt-share-minted">
            <div className="rpt-share-once">
              <Check size={14} aria-hidden /> Copy this now — it is shown only once. Only a hash
              is stored, so it cannot be shown again.
            </div>
            <div className="rpt-share-copyrow">
              <Input
                ref={tokenRef} readOnly value={minted}
                onFocus={(e) => e.currentTarget.select()} aria-label="Share link"
                fieldClassName="rpt-share-token" className="mono"
              />
              <Button variant="primary" size="sm" onClick={copy}>
                <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="rpt-share-form">
            <label>
              <span>Label <em>(optional — for your own list)</em></span>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Weekly figures for the agency" maxLength={60} />
            </label>
            <label>
              <span>Expires after</span>
              <Select value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))}>
                {TTL_CHOICES.map((d) => (
                  <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>
                ))}
              </Select>
            </label>
            <Button variant="primary" onClick={create} disabled={busy}>
              <Link2 size={13} /> Create link
            </Button>
          </div>
        )}

        <div className="rpt-share-list">
          <h4>Existing links</h4>
          {items.length === 0 && <p className="rpt-share-empty">No links yet.</p>}
          {items.map((l) => (
            <div key={l.id} className="rpt-share-row">
              <div className="rpt-share-meta">
                <b>{l.label || l.reportId}</b>
                <span>
                  {l.revokedAt ? 'revoked' : l.isExpired ? 'expired' : `expires ${l.expiresAt.slice(0, 10)}`}
                  {' · '}
                  {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
                </span>
              </div>
              <Pill tone={l.isActive ? 'success' : 'neutral'}>{l.isActive ? 'Active' : 'Inactive'}</Pill>
              {l.isActive && (
                <Button variant="ghost" size="sm" onClick={() => revoke(l.id)} disabled={busy} aria-label="Revoke link">
                  <Trash2 size={13} /> Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

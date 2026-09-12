'use client'

/**
 * PES.7 — the three publish surfaces that live in this browser and nowhere else.
 *
 * Auto-publish (PB.11), the approval gate (PB.12) and rollback restore points (PB.9). Inventory
 * §2.6 records all three as browser-local with server-side successors that were never built, and
 * the honest-UI rule says the rebuilt surfaces must keep saying so. They say it here **once at the
 * top of the panel** rather than three times, and the restore control carries its own, stronger
 * warning — a preference that does not travel is inconvenient, a safety net that does not travel is
 * a trap.
 *
 * 🔴 The panel renders nothing but an explanation when the browser refuses storage. A toggle that
 * silently fails to save is worse than an absent one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Pill, Toggle } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import { bucketGroupKey } from '../channel/amazon/cascade'
import type { ListingAsset } from '../types'
import { STORAGE_SCOPE_NOTE, storageAvailable } from './browserStore'
import {
  clearSnapshots, diffSnapshot, isEmptyDiff, layerRows, readApproval, readAutoPublish, readSnapshots,
  resolveApproval, saveSnapshot, setAutoPublish, snapshotWarning, writeApproval,
  type ApprovalState, type Snapshot,
} from './publishPrefs'
import { describePlan, restorePlan } from './restorePlan'
import styles from '../channel/amazon/matrix.module.css'

export interface LocalPublishSettingsProps {
  productId: string
  channel: string
  marketplace: string | null
  listing: readonly ListingAsset[]
  axisName: string | null
  reload(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

export function LocalPublishSettings(props: LocalPublishSettingsProps) {
  const { productId, channel, marketplace, listing, axisName, reload, write } = props

  const [available, setAvailable] = useState<boolean | null>(null)
  const [auto, setAuto] = useState<Record<string, boolean>>({})
  const [approval, setApproval] = useState<ApprovalState>({ required: false, queue: [] })
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [comparing, setComparing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Probed on mount, in an effect: `storageAvailable()` touches `window`, and the first render is
  // the server's.
  useEffect(() => { setAvailable(storageAvailable()) }, [])

  const refresh = useCallback(() => {
    setAuto(readAutoPublish(productId))
    setApproval(readApproval(productId))
    setSnapshots(readSnapshots(productId, channel, marketplace))
  }, [productId, channel, marketplace])

  useEffect(() => { if (available) refresh() }, [available, refresh])

  const rows = useMemo(() => layerRows(listing, channel, marketplace), [listing, channel, marketplace])
  /** Rows this view shows that live on the all-markets layer, and so are out of this scope. */
  const inheritedCount = useMemo(
    () => (marketplace ? listing.filter((r) => r.platform === channel && r.marketplace === null).length : 0),
    [listing, channel, marketplace],
  )
  const groupKey = useMemo(() => bucketGroupKey(listing, axisName), [listing, axisName])

  const take = useCallback(() => {
    if (rows.length === 0) { setMessage('Nothing to snapshot — this channel has no pictures placed.'); return }
    const ok = saveSnapshot(productId, {
      id: `${Date.now()}`,
      takenAt: new Date().toISOString(),
      channel,
      marketplace,
      rows,
    })
    // Reported, not assumed: a full quota fails the write and the operator must not think it saved.
    setMessage(ok ? null : 'Could not save a restore point — this browser refused to store it.')
    refresh()
  }, [productId, channel, marketplace, rows, refresh])

  const restore = useCallback(async (snapshot: Snapshot) => {
    const plan = restorePlan({ snapshot: snapshot.rows, current: listing, market: marketplace, groupKey })
    setBusy(true)
    const res = await write(writeSubject.surface('publish-settings-restore'), () => apiSend<{ saved: number; deleted: number }>(
      routes.bulkSave(productId), 'POST', { upserts: plan.upserts, deletes: plan.deletes }))
    setBusy(false)
    if (!res.ok) { setMessage(res.message); return }
    setMessage(null)
    await reload()
  }, [listing, marketplace, groupKey, productId, write, reload])

  if (available === null) return null
  if (available === false) {
    return (
      <section className={styles.truth}>
        <header className={styles.head}><h3 className={styles.truthTitle}>Publish settings</h3></header>
        <p className={styles.notice}>
          This browser is not allowing sites to store data, so auto-publish, the approval gate and
          restore points are unavailable here. They are browser-local features — there is nothing
          stored on your account to fall back to.
        </p>
      </section>
    )
  }

  const autoOn = auto[channel] === true
  const compared = snapshots.find((s) => s.id === comparing)
  const diff = compared ? diffSnapshot(compared.rows, rows) : null

  return (
    <section className={styles.truth}>
      <header className={styles.head}>
        <h3 className={styles.truthTitle}>Publish settings</h3>
        <Pill tone="neutral">This browser only</Pill>
        <span className={styles.spacer} />
      </header>

      <p className={styles.notice}>{STORAGE_SCOPE_NOTE}</p>
      {message && <p className={styles.warning} role="alert">{message}</p>}

      <div className={styles.settingRow}>
        <Toggle
          checked={autoOn}
          onChange={(next) => { setAutoPublish(productId, channel, next); refresh() }}
          aria-label={`Publish to ${channel} automatically after a change`}
        />
        <span className={styles.settingLabel}>Publish to {channel} automatically after a change</span>
      </div>

      <div className={styles.settingRow}>
        <Toggle
          checked={approval.required}
          onChange={(next) => { writeApproval(productId, { ...approval, required: next }); refresh() }}
          aria-label="Require approval before publishing"
        />
        <span className={styles.settingLabel}>Require approval before publishing</span>
        {approval.queue.length > 0 && <Pill tone="warning">{approval.queue.length} waiting</Pill>}
      </div>

      {approval.queue.length > 0 && (
        <div className={styles.jobList}>
          {approval.queue.map((q) => (
            <div key={q.id} className={styles.approvalRow}>
              <span className={styles.jobChannel}>
                {q.channel}{q.marketplace ? ` · ${q.marketplace}` : ''}
              </span>
              <span className={styles.jobWhen}>{new Date(q.requestedAt).toLocaleString()}</span>
              <span className={styles.auditLabel}>{q.note ?? 'Waiting for approval'}</span>
              <Button size="sm" variant="ghost" onClick={() => { resolveApproval(productId, q.id); refresh() }}>
                Dismiss
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* ── restore points ───────────────────────────────────────── */}
      <div className={styles.recordHead}>
        <h4 className={styles.recordTitle}>Restore points</h4>
        <span className={styles.recordSource}>{channel}{marketplace ? ` · ${marketplace}` : ''}</span>
      </div>

      {/* Stronger than the panel's note, and placed where the restore actually is. */}
      <p className={styles.notice}>{snapshotWarning(snapshots.length)}</p>

      <div className={styles.settingRow}>
        <Button size="sm" variant="secondary" onClick={take} disabled={busy}>
          Save a restore point now
        </Button>
        <span className={styles.formReason}>
          {rows.length > 0
            ? `Records the ${rows.length} picture${rows.length === 1 ? '' : 's'} pinned to `
              + `${channel}${marketplace ? ` · ${marketplace}` : ''}.`
            : `Nothing is pinned to ${channel}${marketplace ? ` · ${marketplace}` : ''}, `
              + 'so there is nothing to record.'}
          {/* The number would otherwise look wrong: the matrix shows far more than this, because
              most of it is inherited from the all-markets layer and belongs to that layer. */}
          {inheritedCount > 0 && ` The ${inheritedCount} shown here from the all-markets layer `
            + 'belong to that layer and are not part of this restore point.'}
        </span>
        {snapshots.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { clearSnapshots(productId, channel, marketplace); setComparing(null); refresh() }}
          >
            Forget all
          </Button>
        )}
      </div>

      {snapshots.length > 0 && (
        <div className={styles.jobList}>
          {snapshots.map((s) => {
            // Computed per row so the consequence is visible on the control itself — an operator
            // may press Restore without ever pressing Compare.
            const plan = restorePlan({ snapshot: s.rows, current: listing, market: marketplace, groupKey })
            return (
            <div key={s.id} className={styles.snapshotRow} title={describePlan(plan)}>
              <span className={styles.jobWhen}>{new Date(s.takenAt).toLocaleString()}</span>
              <span className={styles.receipt}>
                {s.rows.length} picture{s.rows.length === 1 ? '' : 's'}
              </span>
              {plan.unpublishes > 0
                ? <Pill tone="warning">{plan.unpublishes} would unpublish</Pill>
                : <span />}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setComparing(comparing === s.id ? null : s.id)}
              >
                {comparing === s.id ? 'Hide changes' : 'Compare'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => { void restore(s) }}
              >
                Restore
              </Button>
            </div>
            )
          })}
        </div>
      )}

      {compared && diff && (
        <section className={styles.issues}>
          <span className={styles.issuesTitle}>
            Since {new Date(compared.takenAt).toLocaleString()}
          </span>
          {isEmptyDiff(diff) ? (
            <p className={styles.healthLine}>
              Nothing has changed on this channel since that restore point.
            </p>
          ) : (
            <ul>
              {diff.added.map((r) => <li key={`a${r.slot}${r.url}`}>Added to {r.slot} ({r.groupValue ?? 'all colours'})</li>)}
              {diff.removed.map((r) => <li key={`r${r.slot}${r.url}`}>Removed from {r.slot} ({r.groupValue ?? 'all colours'})</li>)}
              {diff.moved.map((m) => <li key={`m${m.row.slot}${m.row.url}`}>Moved in {m.row.slot} ({m.from} → {m.to})</li>)}
            </ul>
          )}
          <span className={styles.formReason}>
            {describePlan(restorePlan({ snapshot: compared.rows, current: listing, market: marketplace, groupKey }))}
          </span>
        </section>
      )}
    </section>
  )
}

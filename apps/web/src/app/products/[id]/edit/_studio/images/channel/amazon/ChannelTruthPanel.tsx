'use client'

/**
 * PES.7 — what Amazon actually has, next to what Nexus would send.
 *
 * 🔴 The distinction this surface exists to protect: **"not checked" is not "no drift".** The
 * live read-back cache is empty until someone refreshes it (measured on GALE-JACKET: 0 rows), and a
 * panel that rendered that as a clean bill of health would be asserting something nobody has looked
 * at. So an unchecked channel says so, and offers the check.
 *
 * The refresh is a READ against Amazon (`getListingsItem`), not a write — it changes nothing on the
 * listing. It is still an explicit operator action rather than something this tab does on load,
 * because it spends an SP-API call and the answer keeps.
 */
import { useCallback, useEffect, useState } from 'react'

import { Button, Pill } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiGet, apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import { staleActionability, type LiveImage } from './channelTruth'
import { asinsLosingImages, readMirrorDiff, type MirrorDiff } from './mirrorPlan'
import styles from './matrix.module.css'

export interface ChannelTruthPanelProps {
  productId: string
  market: string | null
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

interface StaleResult { totalStaleRows: number; staleAsins: string[]; staleVariantIds: string[] }

const THUMB_PX = 120

export function ChannelTruthPanel({ productId, market, write }: ChannelTruthPanelProps) {
  const [stale, setStale] = useState<StaleResult | null>(null)
  const [live, setLive] = useState<LiveImage[] | null>(null)
  const [mirror, setMirror] = useState<MirrorDiff | null>(null)
  const [checking, setChecking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stale is cheap and derived from data Nexus already holds, so it loads with the scope. The live
  // read-back is an SP-API call and stays operator-triggered.
  useEffect(() => {
    if (!market) { setStale(null); setLive(null); return }
    let cancelled = false
    setChecking(true)
    void (async () => {
      // All three read from data Nexus already holds — none of them calls Amazon.
      const [s, l, d] = await Promise.all([
        apiGet<StaleResult>(routes.amazonStale(productId, market)),
        apiGet<LiveImage[]>(`/api/products/${productId}/live-channel-images?channel=AMAZON&marketplace=${encodeURIComponent(market)}`),
        apiGet<MirrorDiff>(`/api/products/${productId}/amazon-images/mirror-diff?marketplace=${encodeURIComponent(market)}`),
      ])
      if (cancelled) return
      if (s.ok) setStale(s.data)
      if (l.ok) setLive(Array.isArray(l.data) ? l.data : [])
      if (d.ok) setMirror(d.data)
      setError(!s.ok ? s.message : !l.ok ? l.message : !d.ok ? d.message : null)
      setChecking(false)
    })()
    return () => { cancelled = true }
  }, [market, productId])

  const refreshLive = useCallback(async () => {
    if (!market) return
    setRefreshing(true)
    setError(null)
    const res = await write(writeSubject.surface('amazon-live-refresh'), () => apiSend<unknown>(
      `/api/products/${productId}/live-channel-images/refresh`, 'POST',
      { channel: 'AMAZON', marketplace: market }))
    if (!res.ok) { setError(res.message); setRefreshing(false); return }
    const l = await apiGet<LiveImage[]>(
      `/api/products/${productId}/live-channel-images?channel=AMAZON&marketplace=${encodeURIComponent(market)}`)
    if (l.ok) setLive(Array.isArray(l.data) ? l.data : [])
    setRefreshing(false)
  }, [market, productId, write])

  if (!market) return null

  const staleInfo = staleActionability(stale)
  const neverChecked = live !== null && live.length === 0
  // 🔴 The diff is only a comparison if there is something to compare against — see mirrorPlan.ts.
  const mirrorReading = readMirrorDiff({ diff: mirror, liveRowCount: live?.length ?? 0 })
  const losing = asinsLosingImages(mirror)

  return (
    <section className={styles.truth}>
      <header className={styles.head}>
        <h3 className={styles.truthTitle}>What Amazon has</h3>
        {checking && <span className={styles.count}>checking…</span>}
        {staleInfo.count > 0 && <Pill tone="warning">{staleInfo.count} stale</Pill>}
        {/* Never a green "in sync" pill off an empty cache — that is the claim this panel refuses. */}
        {neverChecked && <Pill tone="neutral">not checked</Pill>}
        {live && live.length > 0 && <Pill tone="neutral">{live.length} images read back</Pill>}
        <span className={styles.spacer} />
        <Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void refreshLive()}>
          {refreshing ? 'Asking Amazon…' : live && live.length ? 'Check again' : 'Check Amazon'}
        </Button>
      </header>

      {error && <p className={styles.warning} role="alert">{error}</p>}

      {staleInfo.count > 0 && (
        <p className={styles.notice}>
          {staleInfo.count} published row{staleInfo.count === 1 ? ' has' : 's have'} a master image
          that changed after it was sent. Amazon still has the older picture.
          {/* The action is withheld, and WHY is said — a button that cannot target anything is worse
              than no button. */}
          {staleInfo.note ? ` ${staleInfo.note}` : ''}
        </p>
      )}

      {neverChecked && (
        <p className={styles.notice}>
          Nobody has read this listing back from Amazon yet, so there is nothing to compare against.
          This is <strong>not</strong> the same as saying the images match — checking asks Amazon
          what it is actually serving. It reads the listing; it changes nothing.
        </p>
      )}

      {/* An exact-mirror publish REMOVES what Amazon has and Nexus does not. This is the sentence
          that decides whether an operator should run one, so it is never abbreviated to a number. */}
      <p className={mirrorReading.trust === 'unknown' ? styles.notice : styles.pickerState}>
        {mirrorReading.statement}
      </p>

      {mirrorReading.canDescribePublish && losing.length > 0 && (
        <section className={styles.issues}>
          <span className={styles.issuesTitle}>Would lose images on Amazon</span>
          <ul>
            {losing.slice(0, 8).map((a) => (
              <li key={a.sku}>
                <code>{a.asin ?? a.sku}</code> — {a.deletes.length} slot
                {a.deletes.length === 1 ? '' : 's'} removed ({a.deletes.map((d) => d.slot).join(', ')})
              </li>
            ))}
            {losing.length > 8 && <li>and {losing.length - 8} more</li>}
          </ul>
        </section>
      )}

      {live && live.length > 0 && (
        <div className={styles.liveStrip}>
          {live.slice(0, 24).map((l, i) => (
            <figure key={i} className={styles.liveTile} title={`${l.externalSku ?? ''} · ${l.slot ?? ''}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.liveImg} src={cdnFit(l.url, THUMB_PX)} alt="" loading="lazy" />
              <figcaption className={styles.liveCap}>{l.slot ?? '—'}</figcaption>
            </figure>
          ))}
          {live.length > 24 && <span className={styles.count}>and {live.length - 24} more</span>}
        </div>
      )}
    </section>
  )
}

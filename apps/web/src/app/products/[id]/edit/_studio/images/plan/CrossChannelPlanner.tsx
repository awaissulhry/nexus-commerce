'use client'

/**
 * PES.7 — the cross-channel publish planner (PB.5 rebuilt).
 *
 * 🔴 The old `CrossChannelPublishModal` fired a five-market Amazon loop with no indication that all
 * five write the same ASIN images. This one leads with the count of **destinations**, not targets,
 * and names the mechanism each one rides — the Owner's D1 ruling made that preview mandatory.
 *
 * 🔴 What actually reaches a marketplace is the SERVER'S publish gate, never a flag from this
 * screen. The `dryRun` body field is inert (`submitAmazonImageFeed` never forwards it), so this
 * surface does not offer a rehearsal switch it cannot honour: it reports what the gate says will
 * happen and lets the operator decide with that in front of them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Checkbox, Pill } from '@/design-system/primitives'

import { apiGet, apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import type { PublishReadinessByChannel } from '../channel/amazon/publishPlan'
import {
  buildTargets, collisionGroups, collisionSentence, isEmpty, mechanismNote, planHeadline,
  summarisePlan, type TargetRow,
} from './crossChannel'
import styles from '../channel/amazon/matrix.module.css'

export interface CrossChannelPlannerProps {
  productId: string
  channels: readonly { id: string; markets: readonly string[] }[]
  listing: readonly TargetRow[]
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
  reload(): Promise<void>
}

/**
 * Whether a channel's gate is open, straight from the server.
 *
 * 🔴 Indexes the envelope by a KNOWN key, with no cast. This used to type the whole response as a
 * single `PublishReadiness` and then `as unknown as Record<string, …>` to reach the channels — the
 * type was simply wrong, and the cast is what let it compile. An unknown channel returns `null`
 * ("the server did not report on it"), which is not the same as a closed gate.
 */
function gateOf(
  readiness: PublishReadinessByChannel | null,
  channel: string,
): { open: boolean; mode: string } | null {
  if (!readiness) return null
  const key = channel.toLowerCase()
  const entry = key === 'amazon' ? readiness.amazon
    : key === 'ebay' ? readiness.ebay
      : key === 'shopify' ? readiness.shopify
        : undefined
  if (!entry) return null
  return { open: entry.enabled === true, mode: entry.mode ?? 'unknown' }
}

export function CrossChannelPlanner(props: CrossChannelPlannerProps) {
  const { productId, channels, listing, write, reload } = props

  const [open, setOpen] = useState(false)
  const [readiness, setReadiness] = useState<PublishReadinessByChannel | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState<string | null>(null)
  const [log, setLog] = useState<Array<{ key: string; text: string; ok: boolean }>>([])

  useEffect(() => {
    if (!open || readiness) return
    void (async () => {
      const res = await apiGet<PublishReadinessByChannel>(routes.publishReadiness())
      if (res.ok) setReadiness(res.data ?? null)
    })()
  }, [open, readiness])

  const targets = useMemo(() => buildTargets({ channels, listing }), [channels, listing])
  const sendable = useMemo(() => targets.filter((t) => !isEmpty(t) && t.mechanism !== 'unsupported'), [targets])
  const selected = useMemo(() => sendable.filter((t) => chosen.has(t.key)), [sendable, chosen])
  const summary = useMemo(() => summarisePlan(selected), [selected])
  const collisions = useMemo(() => collisionGroups(selected), [selected])
  const mechanisms = useMemo(
    () => [...new Set(selected.map((t) => t.mechanism))],
    [selected],
  )

  const toggle = useCallback((key: string) => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  /** Fired one at a time — a channel that refuses must not take the others down with it. */
  const run = useCallback(async () => {
    setLog([])
    for (const t of selected) {
      setRunning(t.key)
      const url = t.channel === 'AMAZON' ? routes.amazonPublish(productId)
        : t.channel === 'EBAY' ? routes.ebayPublish(productId)
          : routes.shopifyPublish(productId)
      const body = t.channel === 'AMAZON' ? { marketplace: t.marketplace } : {}
      const res = await write(writeSubject.surface(`publish:${t.key}`), () => apiSend<{ dryRun?: boolean; feedId?: string | null }>(url, 'POST', body))
      setLog((prev) => [...prev, {
        key: t.key,
        ok: res.ok,
        // The server's answer, never the request's intent — see PublishPanel for why.
        text: res.ok
          ? (res.data?.dryRun === true
            ? 'Dry run — the channel was not contacted.'
            : res.data?.dryRun === false
              ? 'Queued. The channel has not confirmed yet.'
              : 'Completed, but the server did not say whether it was submitted.')
          : res.message,
      }])
      setRunning(null)
    }
    await reload()
  }, [selected, productId, write, reload])

  const anyGateOpen = selected.some((t) => gateOf(readiness, t.channel)?.open === true)
  /**
   * Whether every offered target shares one gate state.
   *
   * When they do, the footer sentence says it once and the per-card pill is sixteen repetitions of
   * a single fact — which also squeezed the coverage text into "45 fro…". A chip earns its place by
   * distinguishing one card from another; when it distinguishes nothing it is noise.
   */
  const gatesDiffer = useMemo(() => {
    const states = new Set(sendable.map((t) => gateOf(readiness, t.channel)?.open === true))
    return states.size > 1
  }, [sendable, readiness])

  return (
    <section className={styles.truth}>
      <header className={styles.head}>
        <h3 className={styles.truthTitle}>Publish to several places</h3>
        {sendable.length > 0 && <span className={styles.count}>{sendable.length} possible targets</span>}
        <span className={styles.spacer} />
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</Button>
      </header>

      {open && (
        <>
          {/* The count that matters, stated before anything can be selected. */}
          <p className={styles.notice}>{planHeadline(summary)}</p>

          {collisions.map((group) => (
            <p key={group.map((t) => t.key).join()} className={styles.warning} role="status">
              {collisionSentence(group)}
            </p>
          ))}

          <div className={styles.targetGrid}>
            {sendable.map((t) => {
              const gate = gateOf(readiness, t.channel)
              return (
                <label key={t.key} className={styles.targetCard}>
                  <Checkbox checked={chosen.has(t.key)} onChange={() => toggle(t.key)} />
                  <span className={styles.targetName}>
                    {t.channel}{t.marketplace ? ` · ${t.marketplace}` : ''}
                  </span>
                  <span className={styles.targetCoverage}>
                    {t.pinned > 0 && `${t.pinned} pinned`}
                    {t.pinned > 0 && t.inherited > 0 && ' · '}
                    {t.inherited > 0 && `${t.inherited} from all-markets`}
                  </span>
                  {gatesDiffer && gate && !gate.open && <Pill tone="neutral">gate closed</Pill>}
                  {running === t.key && <Pill tone="info">sending…</Pill>}
                </label>
              )
            })}
          </div>

          {/* One note per mechanism, not one per card — five identical paragraphs teach nothing. */}
          {mechanisms.map((m) => (
            <p key={m} className={styles.notice}>{mechanismNote(m)}</p>
          ))}

          {targets.some((t) => isEmpty(t)) && (
            <p className={styles.pickerState}>
              {targets.filter(isEmpty).length} target
              {targets.filter(isEmpty).length === 1 ? ' has' : 's have'} no pictures at all and
              {targets.filter(isEmpty).length === 1 ? ' is' : ' are'} not offered.
            </p>
          )}

          <div className={styles.settingRow}>
            <Button
              size="sm"
              variant="secondary"
              disabled={selected.length === 0 || running !== null}
              onClick={() => { void run() }}
            >
              {selected.length === 0
                ? 'Choose a target'
                : anyGateOpen
                  ? `Send to ${selected.length} target${selected.length === 1 ? '' : 's'}`
                  : `Rehearse ${selected.length} target${selected.length === 1 ? '' : 's'}`}
            </Button>
            <span className={styles.formReason}>
              {readiness === null
                ? 'Checking what the publish gate allows…'
                : anyGateOpen
                  ? 'The publish gate is open — this reaches the channel for real.'
                  : 'Every gate is closed on this deployment, so nothing here reaches a channel.'}
            </span>
          </div>

          {log.length > 0 && (
            <div className={styles.jobList}>
              {log.map((entry) => (
                <div key={entry.key} className={styles.approvalRow}>
                  <Pill tone={entry.ok ? 'success' : 'danger'}>{entry.key}</Pill>
                  <span className={styles.auditLabel}>{entry.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

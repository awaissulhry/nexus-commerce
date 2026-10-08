'use client'

/**
 * Step 4 Send to FBA (Owner 2026-10-07; plan 11-step4-build-plan.md §4c) — the FBA plans drawer (Part E2): the family's
 * open plans and drafts, one click from the Matrix. Owner 2026-10-08: the FBA shipments page (Fulfillment › Outbound) is
 * the one place for every family; this drawer stays on the Matrix (the FBA qty cell opens it) and shows a draft's SKUs with
 * a link to the page, where the draft is edited and sent.
 *
 * Props (all the host passes):
 *   open        — shows the drawer (DS `Drawer`, right, 480 px; full width on a phone).
 *   onClose     — Esc, the ✕ and the backdrop call it.
 *   productId   — the family root (or one product): the drawer lists the OPEN plans and drafts holding any SKU of it,
 *                 newest first (`GET /api/fba/inbound/plans?productId=<id>&open=1`).
 *   planId      — optional: open on this plan. Absent = the list, or the plan itself when there is only one. A plan that
 *                 is no longer open is read by its id.
 *   onPlanChanged — optional: a click here changed a plan (choice, cancel, try again, shipped); gets the server's view.
 *
 * Per plan: `useFbaPlanDetail` (the same view and clicks as the page). Live: `fba.plan_changed` arrives as
 * `inventory.stock_changed` with `meta.subtype 'fba-plan'` (E1's bridge) and the drawer re-reads; it also re-reads gently
 * by itself (8 s while the job runs, else 60 s). Never a state the server did not send.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FBA_SEND_COPY, type FbaPlanView } from '@nexus/shared/fba-send'
import { Banner, Drawer, EmptyState, PressableRow, ProgressBar } from '@/design-system/components'
import { Button, Pill } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import Link from '@/lib/workspaces/Link'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { useFbaPlanDetail } from './FbaPlanDetail'
import {
  DRAWER_COPY, FBA_ROUTES, isFbaPlanEvent, isRunning, planFacts, planName, readOnePlanAnswer, readPlansAnswer, rereadDelay, shownPlanId,
  statusText, statusTone,
} from './plansDrawer'
import { fbaPageHref } from './sendToFba'
import styles from './plansDrawer.module.css'

export interface FbaPlansDrawerProps {
  open: boolean
  onClose: () => void
  /** The family root (or one product); the drawer lists the open plans holding any of its SKUs. */
  productId: string
  /** Open on this plan; absent = the list (or the only plan). */
  planId?: string | null
  /** A click here changed this plan (the server's view after the click). */
  onPlanChanged?: (plan: FbaPlanView) => void
}

export const FBA_PLANS_DRAWER_WIDTH = 480

/** A burst of plan events (one per SKU) is one read. */
const LIVE_DEBOUNCE_MS = 300

export function FbaPlansDrawer({ open, onClose, productId, planId, onPlanChanged }: FbaPlansDrawerProps) {
  const [plans, setPlans] = useState<FbaPlanView[] | null>(null)
  /** The shown plan when the open list does not hold it (cancelled, closed, or asked for by id). */
  const [extra, setExtra] = useState<FbaPlanView | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState(0)
  /** undefined = the host's choice (`planId`, else the only plan); null = the list; a string = the plan the person opened. */
  const [pick, setPick] = useState<string | null | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')

  const shownId = pick === undefined ? shownPlanId(plans ?? [], null, planId) : pick
  const shown = useMemo(
    () => (shownId ? plans?.find(p => p.id === shownId) ?? (extra?.id === shownId ? extra : null) : null),
    [plans, extra, shownId],
  )
  const shownRef = useRef<string | null>(shownId)
  shownRef.current = shownId

  /* ── reading ─────────────────────────────────────────────────────────────────────────────────── */

  const seq = useRef(0)
  /** `want` = the plan to read by id when the open list does not hold it; absent = the one shown now. */
  const load = useCallback(async (want: string | null = shownRef.current) => {
    const mine = ++seq.current
    const base = getBackendUrl()
    try {
      let response: Response
      try { response = await fetch(`${base}${FBA_ROUTES.plans(productId)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
      const list = readPlansAnswer(response.status, await response.json().catch(() => null))
      let one: FbaPlanView | null = null
      let gone: string | null = null
      if (want && !list.some(p => p.id === want)) {
        let single: Response
        try { single = await fetch(`${base}${FBA_ROUTES.plan(want)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
        one = readOnePlanAnswer(single.status, await single.json().catch(() => null))
        if (!one) gone = want
      }
      if (mine !== seq.current) return
      setPlans(list); setExtra(one); setMissing(gone); setReadError(null)
    } catch (error) {
      if (mine !== seq.current) return
      setReadError(error instanceof Error ? error.message : DRAWER_COPY.readNoAnswer)
    } finally {
      if (mine === seq.current) setReadAt(Date.now())
    }
  }, [productId])

  // Every opening starts clean on the host's plan.
  useEffect(() => {
    if (!open) return
    setPick(undefined); setAnnouncement('')
    void load(planId ?? null)
  }, [open, planId, load])

  // Live: the server's plan event (E1's bridge) — coalesced, so a burst for many SKUs is one read.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useInvalidationChannel('inventory.stock_changed', event => {
    if (!open || !isFbaPlanEvent(event) || debounce.current) return
    debounce.current = setTimeout(() => { debounce.current = null; void load() }, LIVE_DEBOUNCE_MS)
  })
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // The gentle re-read, and a read when the window comes back.
  const visible = useMemo(() => [...(plans ?? []), ...(extra && !plans?.some(p => p.id === extra.id) ? [extra] : [])], [plans, extra])
  useEffect(() => {
    if (!open || readAt === 0) return
    const t = setTimeout(() => { if (document.visibilityState === 'visible') void load() }, rereadDelay(visible))
    return () => clearTimeout(t)
  }, [open, readAt, visible, load])
  useEffect(() => {
    if (!open) return
    const back = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [open, load])

  // A screen reader hears a change of the shown plan's status once.
  const lastStatus = useRef<{ id: string; status: string } | null>(null)
  useEffect(() => {
    if (!shown) return
    const before = lastStatus.current
    lastStatus.current = { id: shown.id, status: shown.status }
    if (before && before.id === shown.id && before.status !== shown.status) setAnnouncement(`${planName(shown)}: ${statusText(shown.status)}`)
  }, [shown])

  // Keyboard: opening a plan from the list, or going back to it, moves focus there (the row or link pressed is gone).
  const listRef = useRef<HTMLUListElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (pick === undefined) return
    const t = window.setTimeout(() => (pick === null ? listRef.current : detailRef.current)?.focus({ preventScroll: true }), 0)
    return () => window.clearTimeout(t)
  }, [pick])

  /* ── the shown plan (the same view and clicks as the page) ───────────────────────────────────── */

  const applyPlan = useCallback((plan: FbaPlanView) => {
    setPlans(previous => (previous?.some(p => p.id === plan.id) ? previous.map(p => (p.id === plan.id ? plan : p)) : previous))
    setExtra(previous => (previous?.id === plan.id || shownRef.current === plan.id ? plan : previous))
  }, [])
  const stale = useCallback(() => { void load() }, [load])
  const draftAction = useCallback((plan: FbaPlanView) => (
    <div><Button asChild size="sm" variant="secondary"><Link href={fbaPageHref({ plan: plan.id })}>{FBA_SEND_COPY.openPage}</Link></Button></div>
  ), [])
  const parts = useFbaPlanDetail({ plan: shown, onApplied: applyPlan, onStale: stale, onPlanChanged, sectionRef: detailRef, draftAction, source: 'fba-plans-drawer' })

  /* ── render ──────────────────────────────────────────────────────────────────────────────────── */

  const othersCount = visible.filter(p => p.id !== shown?.id).length

  return (
    <Drawer
      open={open}
      onClose={onClose}
      // The drawer opens on its heading (the DS drawer looks for `data-drawer-heading`), not on the whole panel, which
      // drew a ring round the drawer (Matrix polish, Owner 2026-10-08).
      title={<span className={styles.heading} tabIndex={-1} data-drawer-heading>{FBA_SEND_COPY.drawerTitle}</span>}
      subtitle={shown ? planName(shown) : undefined}
      footer={parts.footer}
      overlay={parts.overlay}
      width={FBA_PLANS_DRAWER_WIDTH}
      closeLabel={`Close ${FBA_SEND_COPY.drawerTitle}`}
    >
      <div className={styles.body}>
        <p className="nds-vh" role="status" aria-live="polite">{announcement}</p>

        {plans === null && !readError && <ProgressBar indeterminate ariaLabel={DRAWER_COPY.reading} />}

        {readError && (
          <Banner
            tone={plans ? 'warning' : 'danger'}
            title={plans ? DRAWER_COPY.stale : DRAWER_COPY.readFailed}
            action={<Button size="sm" onClick={() => void load()}>{FBA_SEND_COPY.tryAgain}</Button>}
          >
            {readError}
          </Banner>
        )}

        {plans !== null && shownId === null && (
          plans.length === 0
            ? <EmptyState title={DRAWER_COPY.empty} description={DRAWER_COPY.emptyHint} />
            : (
              <ul ref={listRef} tabIndex={-1} className={styles.list} aria-label={DRAWER_COPY.plansLabel}>
                {plans.map(plan => (
                  <li key={plan.id}>
                    <PressableRow label={planName(plan)} description={`${statusText(plan.status)} · ${planFacts(plan)}`} onClick={() => setPick(plan.id)} stacked>
                      <span className={styles.rowFacts}>
                        <Pill tone={statusTone(plan.status)} dot={isRunning(plan.status)}>{statusText(plan.status)}</Pill>
                        <span className={styles.muted}>{planFacts(plan)}</span>
                      </span>
                    </PressableRow>
                  </li>
                ))}
              </ul>
            )
        )}

        {shownId !== null && othersCount > 0 && (
          <div>
            <Button size="sm" variant="link" onClick={() => setPick(null)}>{DRAWER_COPY.allPlans}</Button>
          </div>
        )}

        {shownId !== null && !shown && plans !== null && !readError && (
          missing === shownId ? <EmptyState title={DRAWER_COPY.notFound} /> : <ProgressBar indeterminate ariaLabel={DRAWER_COPY.reading} />
        )}

        {parts.detail}

        <div>
          <Button asChild size="sm" variant="link"><Link href={fbaPageHref()}>{FBA_SEND_COPY.openPage}</Link></Button>
        </div>
      </div>
    </Drawer>
  )
}

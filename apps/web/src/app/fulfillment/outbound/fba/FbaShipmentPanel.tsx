'use client'

/**
 * The FBA shipments page's side panel (`?plan=<id>`; a DS `Drawer`, full screen on a phone): a DRAFT is edited and sent
 * (`useFbaDraftEditor`), a plan under way or done shows the Matrix drawer's own view and clicks (`useFbaPlanDetail`).
 * Live: a plan event re-reads it; the job's states re-read every 8 s, others every 60 s (the drawer's rhythm).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { type FbaPlanView } from '@nexus/shared/fba-send'

import { Banner, Drawer, EmptyState, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { useFbaPlanDetail } from '@/app/products/[id]/edit/_studio/matrix/fba/FbaPlanDetail'
import { DRAWER_COPY, FBA_ROUTES, isFbaPlanEvent, planName, readOnePlanAnswer, rereadDelay } from '@/app/products/[id]/edit/_studio/matrix/fba/plansDrawer'
import { useFbaDraftEditor } from './FbaDraftEditor'
import { PAGE_COPY } from './fbaShipments'

export const FBA_SHIPMENT_PANEL_WIDTH = 1040

export interface FbaShipmentPanelProps {
  planId: string | null
  onClose: () => void
  /** The shipment changed here (saved, sent, deleted, a click): the list reads again. */
  onChanged: () => void
}

const LIVE_DEBOUNCE_MS = 300

export function FbaShipmentPanel({ planId, onClose, onChanged }: FbaShipmentPanelProps) {
  const [plan, setPlan] = useState<FbaPlanView | null>(null)
  const [missing, setMissing] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState(0)

  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!planId) return
    const mine = ++seq.current
    try {
      let response: Response
      try { response = await fetch(`${getBackendUrl()}${FBA_ROUTES.plan(planId)}`) } catch { throw new Error(DRAWER_COPY.readNoAnswer) }
      const one = readOnePlanAnswer(response.status, await response.json().catch(() => null))
      if (mine !== seq.current) return
      setPlan(one); setMissing(!one); setReadError(null)
    } catch (e) {
      if (mine !== seq.current) return
      setReadError(e instanceof Error ? e.message : DRAWER_COPY.readNoAnswer)
    } finally {
      if (mine === seq.current) setReadAt(Date.now())
    }
  }, [planId])

  useEffect(() => {
    setPlan(null); setMissing(false); setReadError(null)
    void load()
  }, [load])

  // Live: the server's plan event — coalesced. A draft is not re-read under the person's typing: only its status matters.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useInvalidationChannel('inventory.stock_changed', (event) => {
    if (!planId || !isFbaPlanEvent(event) || debounce.current) return
    if (event.meta?.planId && event.meta.planId !== planId) return
    debounce.current = setTimeout(() => { debounce.current = null; void load() }, LIVE_DEBOUNCE_MS)
  })
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])
  useEffect(() => {
    if (!planId || readAt === 0 || !plan || plan.status === 'DRAFT') return
    const t = setTimeout(() => { if (document.visibilityState === 'visible') void load() }, rereadDelay([plan]))
    return () => clearTimeout(t)
  }, [planId, readAt, plan, load])

  const isDraft = plan?.status === 'DRAFT'
  const draftParts = useFbaDraftEditor({
    plan: isDraft ? plan : null,
    onSent: () => { onChanged(); void load() },
    onDeleted: () => { onChanged(); onClose() },
    onSaved: onChanged,
  })
  const applied = useCallback((next: FbaPlanView) => { setPlan(next); onChanged() }, [onChanged])
  const stale = useCallback(() => { void load() }, [load])
  const planParts = useFbaPlanDetail({ plan: isDraft ? null : plan, onApplied: applied, onStale: stale, source: 'fba-shipments-page' })

  const footer = isDraft ? draftParts.footer : planParts.footer
  const overlay = isDraft ? draftParts.overlay : planParts.overlay

  return (
    <Drawer
      open={!!planId}
      onClose={onClose}
      title={plan ? planName(plan) : PAGE_COPY.tabsLabel}
      footer={footer}
      overlay={overlay}
      width={isDraft ? FBA_SHIPMENT_PANEL_WIDTH : 520}
      closeLabel={PAGE_COPY.panelClose}
    >
      {plan === null && !readError && !missing && <ProgressBar indeterminate ariaLabel={DRAWER_COPY.reading} />}
      {readError && (
        <Banner tone={plan ? 'warning' : 'danger'} title={plan ? DRAWER_COPY.stale : PAGE_COPY.readFailed}
          action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
          {readError}
        </Banner>
      )}
      {missing && <EmptyState title={PAGE_COPY.notFound} />}
      {plan && (isDraft ? draftParts.body : planParts.detail)}
    </Drawer>
  )
}

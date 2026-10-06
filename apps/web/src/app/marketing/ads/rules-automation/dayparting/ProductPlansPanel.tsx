'use client'

/**
 * OC (2026-10-06) — "Product rank plans": the plans made on the old Rank Control page, with the controls a person
 * needs to keep over one that may still run (switch it on or off, put Top-of-search back). See `productPlans.ts`.
 *
 * Not mounted when there are none: this page does not mount empty sections. A read that fails says so, because a
 * plan that may be running and cannot be seen is exactly what this section is here to prevent.
 */
import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { usePermission } from '@/lib/auth/AuthProvider'
import { Button } from '@/design-system/primitives'
import { Banner, Card, useActionConfirm } from '@/design-system/components'
import {
  PLANS_PATH, planLine, planOutcome, planRevertRequest, planSwitchRequest, planTitle, revertImpact, sendPlanRequest, switchImpact,
  type ProductRankPlan,
} from './productPlans'

export const PRODUCT_PLANS_ANCHOR = 'rd-product-plans'

export function ProductPlansPanel() {
  const canManage = usePermission('ads.campaigns.manage')
  const confirm = useActionConfirm()
  const [plans, setPlans] = useState<ProductRankPlan[] | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}${PLANS_PATH}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      const body = (await r.json()) as { items?: ProductRankPlan[] }
      setPlans(body.items ?? []); setUnreadable(false)
    } catch {
      setUnreadable(true)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  // The rank-defend alert and the old Rank Control address land on this section's anchor; it renders after its read,
  // so the browser's own jump to the anchor has already passed by then.
  useEffect(() => {
    if (plans?.length && typeof window !== 'undefined' && window.location.hash === `#${PRODUCT_PLANS_ANCHOR}`) {
      document.getElementById(PRODUCT_PLANS_ANCHOR)?.scrollIntoView({ block: 'start' })
    }
  }, [plans])

  const act = async (p: ProductRankPlan, kind: 'on' | 'off' | 'revert') => {
    if (busy || !(await confirm.ask(kind === 'revert' ? revertImpact(p) : switchImpact(p, kind === 'on')))) return
    setBusy(p.id); setNote(null)
    try {
      const answer = await sendPlanRequest(kind === 'revert' ? planRevertRequest(p.id) : planSwitchRequest(p.id, kind === 'on'))
      setNote(planOutcome(p, kind, answer))
    } finally {
      setBusy(null)
      await load()
    }
  }

  if (unreadable) {
    return <Banner tone="warning">Could not read the product rank plans just now, so this page cannot show whether one is running. Reload the page to try again.</Banner>
  }
  if (!plans?.length) return null

  return (
    <>
      <Card
        header="Product rank plans"
        headingLevel={2}
        description="Made on the old Rank Control page, which is gone. Each holds one hourly bid plan for a whole product family in one market. They can no longer be edited: switch one off here, and make an hourly bid plan on this page instead."
      >
        {!canManage && <Banner tone="info">You can see these plans; switching them needs the permission to manage ad campaigns.</Banner>}
        {note && <Banner tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Banner>}
        <div className="rd-orphans">
          {plans.map((p) => (
            <Card
              key={p.id} header={planTitle(p)} headingLevel={3} description={planLine(p)}
              headerAction={canManage ? (
                <div className="rd-plan-actions">
                  <Button size="sm" variant={p.enabled ? 'secondary' : 'primary'} onClick={() => void act(p, p.enabled ? 'off' : 'on')} disabled={!!busy}>
                    {busy === p.id ? 'Working…' : p.enabled ? 'Switch off' : 'Switch on'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void act(p, 'revert')} disabled={!!busy}>Put placement back</Button>
                </div>
              ) : undefined}
            />
          ))}
        </div>
      </Card>
      {confirm.element}
    </>
  )
}

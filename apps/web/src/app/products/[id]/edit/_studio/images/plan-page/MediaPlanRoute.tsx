'use client'

import { useEffect, useState, type ReactNode } from 'react'

import { Banner } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'

import { MASTER_SCOPE } from '../../types'
import { useStudioScope } from '../../contracts'
import { isSwitched } from './model'
import { MediaPlanPage } from './MediaPlanPage'
import { SwitchPanel } from './SwitchPanel'
import { useMediaPlan } from './useMediaPlan'
import styles from './planPage.module.css'

/**
 * The Media tab: a family on the photo plan gets the new page on every scope (its older photo tools refuse it since
 * P2b). A family not on the plan keeps today's tools; on the product scope the switch preview sits above them
 * (docs/images-studio-rebuild/P3-PLAN.md).
 */
export function MediaPlanRoute({ productId, fallback }: { productId: string; fallback(header?: ReactNode): ReactNode }) {
  const plan = useMediaPlan(productId)
  const { scope } = useStudioScope()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (plan.state.status !== 'loading') { setSlow(false); return }
    const timer = window.setTimeout(() => setSlow(true), 4000)
    return () => window.clearTimeout(timer)
  }, [plan.state.status])

  if (plan.state.status === 'loading') return <div className={styles.state} aria-busy="true">
    <Skeleton width={320} height={16} /><Skeleton width={560} height={96} /><Skeleton width={560} height={96} />
    {slow && <span>Still loading the photos… <Button size="sm" variant="ghost" onClick={() => void plan.reload()}>Try again</Button></span>}
  </div>
  if (plan.state.status === 'error') return <>
    <div className={styles.switch}><Banner tone="danger" title="The photo plan could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void plan.reload()}>Try again</Button>}>
      {plan.state.message} The older photo tools are below.
    </Banner></div>
    {fallback()}
  </>
  const read = plan.state.read
  if (isSwitched(read)) return <MediaPlanPage read={read} plan={plan} />
  if (scope !== MASTER_SCOPE) return <>
    <div className={styles.switch}><Banner tone="neutral">This product does not use the photo plan yet. To preview it and start, open Media without a channel (the product scope).</Banner></div>
    {fallback()}
  </>
  // The preview sits INSIDE the older tab's scroll area: above it, a tall preview would squeeze the gallery to nothing.
  return <>{fallback(<SwitchPanel productId={productId} onSwitched={() => void plan.reload()} />)}</>
}

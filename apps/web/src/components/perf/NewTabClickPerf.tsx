/**
 * EH.8 — Mounts at the top of each "open in new tab" target page
 * (Datasheet / Flat File / Recover) and runs reportFromTarget()
 * exactly once, on first render. Server-renders nothing; pure
 * client-side telemetry side-effect.
 *
 * Kept as a one-line component so target pages can drop it in
 * without restructuring their render tree.
 */

'use client'

import { useEffect } from 'react'
import { reportFromTarget, type NewTabButton } from '@/lib/perf/markNewTabClick'

interface Props {
  button: NewTabButton
  productId: string
}

export default function NewTabClickPerf({ button, productId }: Props) {
  useEffect(() => {
    reportFromTarget(button, productId)
  }, [button, productId])
  return null
}

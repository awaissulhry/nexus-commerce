'use client'

import { useT } from '../../../../../lib/i18n/provider'
import { DEPTH } from '../depth'

/** A word of this step's catalogue drawn where a label is a node (a menu item another view lists); the caller's messages hold `finance-invoices-depth`. */
export function DepthWord({ k }: { k: string }) {
  const w = useT(DEPTH)
  return <>{w(k)}</>
}

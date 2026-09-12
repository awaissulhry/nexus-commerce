'use client'

import Link from '@/lib/workspaces/Link'
import { Button } from '@/design-system/primitives'
import { useStudioProduct, useStudioScope } from './contracts'
import { MASTER_SCOPE } from './types'

/** Exact destinations stay in their account-aware Information review. The legacy
 * creation wizard does not accept a bound account/listing and cannot take this handoff. */
export function PublishMenu() {
  const product = useStudioProduct()
  const { scope, tab, destination, setTab } = useStudioScope()
  if (scope !== MASTER_SCOPE && tab === 'sheet') return null
  if (scope !== MASTER_SCOPE) return <Button size="sm" variant="secondary" disabled={destination.status !== 'ready'} onClick={() => setTab('sheet')}>
    Review listing information
  </Button>
  return <Button asChild size="sm" variant="secondary">
    <Link href={`/products/${product.id}/list-wizard`}>Choose listing destinations</Link>
  </Button>
}

'use client'

import { useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { headerFromAddress } from './new-model'
import { NewOrderEditor } from './NewOrderEditor'

/**
 * `/w/<company>/sales/orders/new?company=&party=&contact=&ref=` (B-W2a-50; the New order dialog opens it): the page door of the
 * typed New order's ONE editor (F-CP-113: NewOrderEditor; the customer page mounts the same editor in a large window). The header
 * comes from the address; Discard goes back to Sales › Orders; a made order opens.
 */
export function NewOrderPage() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/orders\/new\/?$/, '')
  const header = useMemo(() => headerFromAddress(params), [params])
  return (
    <NewOrderEditor
      frame="page"
      prefix={prefix}
      header={header}
      onDiscarded={() => router.push(`${prefix}/sales/orders`)}
      onMade={(order) => router.push(order.href)}
      onOpen={(href) => router.push(href)}
    />
  )
}

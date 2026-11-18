'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * F-PR-09 — where a screen's VIEW puts "Decide for <customer>" and "Reverse" (the sample round's Approval tab, a swatch's row, a
 * gate's dialog, a new date's answer, our counter-offer in Home › Approvals). A view draws and fetches nothing, so it only names
 * the request (or the record whose requests count) here; the page's container wraps the view in CustomerOverrideProvider
 * (./CustomerOverride.tsx), which reads the request, holds each act with its reason, asks the code and writes. Without a
 * provider — a design case, a test — the slot draws nothing.
 */

export interface CustomerOverrideProps {
  /** The approval request asked of the customer, or the record whose requests count (the newest that matters: pickRequest). */
  readonly source: { readonly requestId: string } | { readonly record: { readonly type: string; readonly id: string } }
  /** The customer's name as the page shows it ("Decide for Brand Alpha…"). */
  readonly customer: string
  /** The page's version of what the request is about: the part reads the request again when it changes. */
  readonly version?: number | string | null
  /** `block`: a card's part (what was done, the buttons); `row`: a table cell (the buttons, one short line). */
  readonly layout?: 'block' | 'row'
}

export interface CustomerOverrideScope {
  readonly render: (props: CustomerOverrideProps) => ReactNode
}

export const CustomerOverrideContext = createContext<CustomerOverrideScope | null>(null)

/** The part, when the page provides it; nothing otherwise. */
export function CustomerOverrideSlot(props: CustomerOverrideProps) {
  const scope = useContext(CustomerOverrideContext)
  return scope ? <>{scope.render(props)}</> : null
}

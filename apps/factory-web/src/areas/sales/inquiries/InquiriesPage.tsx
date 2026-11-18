'use client'

import { PAGE_PATH } from './model'
import { InquiriesView } from './view/InquiriesView'
// F-SA-277: the container's body moved to use-inquiries-list.ts (the ONE Incoming list, for every host).
import { useInquiriesList } from './use-inquiries-list'

/**
 * `/w/<company>/sales/incoming` (SCR-105; B-TH-216: Sales › Incoming, renamed from Inquiries): the requests in the shared list frame with the API's own filters in the address
 * — `?tile=` (a saved filter; the tiles), `?source=`, `?party=` / `?prospect=1`, `?q=` — the inquiry in its DetailModal
 * (`?open=<id>&tab=`, the record container `use-inquiry.tsx`; J / K walk the rows; after a decision the next one opens), New
 * request (`c`, `?new=1`; B-TH-221: the portal's compose with the customer or the prospect, `use-new-request.ts`), "Make
 * incoming request" from a mail (`?mail=<inbound mail id>`, the same window), Assign to… and Decline N over a selection (the
 * API's all-or-none bulk routes). Live `inquiry.*` changes wait behind "N updates · Show".
 * B-TH-233: the rows come from Incoming's one read (GET /sales/incoming: requests, catalogue orders, change requests), page by page
 * ("Show more" by its cursor); `?kind=` narrows to one kind; `?catalogue=<id>` opens a catalogue order beside the list
 * (use-catalogue-order.tsx); `?tile=CUSTOMER_REPLIES` lists the conversations waiting on us (GET /threads/waiting?side=CUSTOMER).
 * F-SA-277: the ONE Incoming list (use-inquiries-list.ts) on its own page — every term its own and in the address, its own band,
 * tiles and reading pane — as before.
 */
export function InquiriesPage() {
  const { model, actions, slots } = useInquiriesList({ basePath: PAGE_PATH })
  return <InquiriesView model={model} actions={actions} slots={slots} />
}

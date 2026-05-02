import { redirect } from 'next/navigation'

// Phase 4 cleanup: /list/amazon-to-ebay folded into /listings/ebay.
export default function Page() {
  redirect('/listings/ebay')
}

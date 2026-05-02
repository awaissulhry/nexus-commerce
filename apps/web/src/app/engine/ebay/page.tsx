import { redirect } from 'next/navigation'

// Phase 4 cleanup: /engine/ebay merged into /listings/ebay.
export default function Page() {
  redirect('/listings/ebay')
}

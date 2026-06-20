/** Bare /builder (no type) — safety redirect back to the Rules list, where the
 *  "+ Rule" button opens the "Select a Rule Type" modal that picks the type. */
import { redirect } from 'next/navigation'

export default function Page() {
  redirect('/marketing/ads/rules-automation')
}

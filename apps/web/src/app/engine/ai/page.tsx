import { redirect } from 'next/navigation'

// Phase 4 cleanup: /engine/ai merged into /listings/generate.
export default function Page() {
  redirect('/listings/generate')
}

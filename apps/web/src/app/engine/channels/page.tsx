import { redirect } from 'next/navigation'

// Phase 4 cleanup: /engine/channels merged into /settings/channels.
export default function Page() {
  redirect('/settings/channels')
}

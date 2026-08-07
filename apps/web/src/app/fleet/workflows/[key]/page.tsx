/**
 * NAF.WF.6a — one routine's page, any key. The client owns the header and
 * the not-found state, because whether a CUSTOM workflow exists is an API
 * truth the server shell cannot know without the server-fetch auth trap —
 * built-ins render identically to before, from the same client.
 */
import { RoutineClient } from './RoutineClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../../fleet-pages.css'
import '../workflows.css'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return <RoutineClient routineKey={key} />
}

/**
 * NAF.WF.2 (S2) — one routine's own page: its story as a graph and a
 * sentence, its health, and (S3) its runs. Unknown keys 404 — the three
 * built-ins are the only routines that exist until the stored model lands.
 */
import { notFound } from 'next/navigation'
import { FleetPageShell } from '../../_shell/FleetPageShell'
import { BUILTIN_ROUTINES } from '../routines'
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
  const routine = BUILTIN_ROUTINES.find((r) => r.key === key)
  if (!routine) notFound()
  return (
    <FleetPageShell title={routine.name} sub={routine.purpose}>
      <RoutineClient routineKey={routine.key} />
    </FleetPageShell>
  )
}

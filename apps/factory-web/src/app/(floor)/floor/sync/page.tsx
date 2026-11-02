import { FloorSync } from '../../../../floor/queue/Sync'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/sync` — waiting to send: this tablet's queue, refused actions with their fix, recorded today (SCR-023). */
export default function FloorSyncPage() {
  return <FloorSync />
}

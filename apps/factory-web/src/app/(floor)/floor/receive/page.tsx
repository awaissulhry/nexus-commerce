import { FloorReceive } from '../../../../floor/tasks/receive/Receive'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/receive` — receive goods against a purchase order: scan the PO, receive hide by hide, print the tags (SCR-092). */
export default function FloorReceivePage() {
  return <FloorReceive />
}

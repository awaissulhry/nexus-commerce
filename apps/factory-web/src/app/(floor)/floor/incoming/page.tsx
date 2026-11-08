import { FloorIncoming } from '../../../../floor/tasks/incoming/Incoming'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/incoming` — incoming inspection: the lot hide by hide, rolls, components, the decision signed with the PIN (SCR-175). */
export default function FloorIncomingPage() {
  return <FloorIncoming />
}

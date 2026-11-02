import { FloorKits } from '../../../../floor/tasks/kits/Kits'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/kits` — subcontract kits: send a kit with its DDT, receive the goods back bundle by bundle (SCR-181). */
export default function FloorKitsPage() {
  return <FloorKits />
}

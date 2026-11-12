import { FloorMove } from '../../../../floor/tasks/move/Move'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/move` — Move & put away: scan what you move, then the place's label (SCR-177, B-W2b-308). */
export default function FloorMovePage() {
  return <FloorMove />
}

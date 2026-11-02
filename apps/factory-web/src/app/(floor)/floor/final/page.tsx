import { FloorFinal } from '../../../../floor/tasks/final-inspection/Final'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/final` — final inspection and release at the inspection bench (SCR-097). */
export default function FloorFinalPage() {
  return <FloorFinal />
}

import { FloorMyWork } from '../../../../floor/tasks/mywork/MyWork'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/mywork` — the station's queue from the published plan: the next task big, then the rest (SCR-089). */
export default function FloorMyWorkPage() {
  return <FloorMyWork />
}

import { FloorOperation } from '../../../../floor/tasks/scans/Operation'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/operation` — report a bundle at your operation: good, scrap and rework, undo, ask a correction (SCR-090). */
export default function FloorOperationPage() {
  return <FloorOperation />
}

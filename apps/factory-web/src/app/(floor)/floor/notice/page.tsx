import { FloorNotice } from '../../../../floor/notice/Notice'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/notice` — the worker notice, the gate before the first scan (SCR-025). */
export default function FloorNoticePage() {
  return <FloorNotice />
}

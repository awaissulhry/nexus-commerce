import { FloorSds } from '../../../../floor/tasks/sds/Sds'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/**
 * `/floor/sds?cabinet=<code>` — the safety data sheets at a cabinet (SCR-213-floor, B-W2b-143): a cabinet's QR opens it
 * through Scan anything; everything it shows comes from what the tablet keeps, so it reads without network.
 */
export default function FloorSdsPage() {
  return <FloorSds />
}

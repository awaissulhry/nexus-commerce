import { FloorStart } from '../../../floor/basket/home/FloorStart'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor` — the floor home: the station's tiles and the scan strip (SCR-022); owb-fl5: on a phone, the basket home. */
export default function FloorHomePage() {
  return <FloorStart />
}

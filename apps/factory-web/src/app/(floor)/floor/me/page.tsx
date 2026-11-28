import { FloorMe } from '../../../../floor/me/Me'

/** B-W2b-F6: visited once, a phone opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/me` — Me: my team and its leader, what I can do, My day, language, Large words, Sound, Tell the office (owb-fl8). */
export default function FloorMePage() {
  return <FloorMe />
}

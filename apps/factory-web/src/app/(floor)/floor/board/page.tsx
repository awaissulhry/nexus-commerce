import { FloorBoardPage } from '../../../../floor/board/Board'

/** B-W2b-F6: visited once, a phone opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/board` — Board, the team leader's tab: My team · Whole floor, a chip per department, the baskets (owb-fl9). */
export default function FloorBoardRoute() {
  return <FloorBoardPage />
}

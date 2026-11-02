import { FloorSignIn } from '../../../../floor/sign-in/SignIn'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/sign-in` — badge (or name) and PIN; a new PIN after a reset; switch person (SCR-021). */
export default function FloorSignInPage() {
  return <FloorSignIn />
}

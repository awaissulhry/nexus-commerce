/**
 * W1-BGF (the W1 browser stages' repair): where the floor app's gate sends a signed-in person who is on the sign-in page — the
 * worker notice when it is due, else where the welcome cards ended (the job they opened) or the person's landing — or null to
 * stay. A move the tablet took back (FloorMoves: the server did not answer in time, the frame says so) is tried again once its
 * words have gone, so a slow server never leaves a signed-in person on the badge screen.
 */
export function leaveSignIn(input: {
  readonly noticeDue: boolean
  readonly arriving: boolean
  readonly pendingSwitch: boolean
  readonly crewStep: boolean
  readonly moveHeld: boolean
  readonly arrivalTo: string | null
  readonly landing: string
  readonly notice: string
}): string | null {
  if (input.pendingSwitch || input.crewStep) return null
  if (input.noticeDue) return input.notice
  if (input.arriving || input.moveHeld) return null
  return input.arrivalTo ?? input.landing
}

/**
 * PinSignBlock's rules (B-W2b-28, D22 / A2 G12): SignBlock's PIN variant for the floor — what is signed, what the
 * signature means in words, who signs, then the PIN pad.
 *
 * - **Order on the screen**: the summary (what is signed), the meaning, the signer ("Signing as Maria Rossi" with
 *   "Not you?"), what is recorded, then the pad. Nothing to sign is ever hidden behind the pad.
 * - **Held**: `heldReason` (signing needs the network; the item is not ready) holds every key and says why on screen;
 *   `locked` (too many wrong PINs) holds every key and forgets the digits; `busy` (the PIN is being checked) holds the
 *   keys and says so. A done block shows the app's end state instead of the pad.
 * - **Evidence is the app's**: `onSign` hands over the PIN only, once all digits are typed; the app checks it and
 *   records who, when, the device and the summary's fingerprint. The block never shows, keeps or speaks a digit
 *   (`PinPad`).
 */

export type PinSignState = 'idle' | 'busy' | 'done'

export interface PinSignInput {
  state?: PinSignState
  heldReason?: string | null
  locked?: boolean
}

export interface PinSignView {
  /** Draw the pad (false once done). */
  showPad: boolean
  /** Every key held, the digits forgotten (locked or held). */
  padLocked: boolean
  /** Every key held while the PIN is checked. */
  padBusy: boolean
  /** The reason to show on screen, if the pad is held for one. */
  heldReason: string | null
}

export function pinSignView({ state = 'idle', heldReason, locked = false }: PinSignInput): PinSignView {
  if (state === 'done') return { showPad: false, padLocked: false, padBusy: false, heldReason: null }
  const reason = heldReason?.trim() ? heldReason : null
  return { showPad: true, padLocked: locked || reason !== null, padBusy: state === 'busy', heldReason: reason }
}

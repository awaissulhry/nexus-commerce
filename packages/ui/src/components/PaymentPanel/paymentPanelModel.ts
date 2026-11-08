/**
 * PaymentPanel's rules (B-W2b-155): what the panel shows in each state of a payment. Pure. The panel never holds card or
 * bank data: the provider's own fields are drawn by the page (or mounted by the provider's script into the panel's box).
 */

/**
 * Where the payment stands: `idle` (nothing started: choose a method, Continue), `starting` (the page asks for a payment
 * at the provider), `ready` (the provider's fields are shown), `paying` (sent to the provider), `waiting` (the provider
 * said "processing": the bank decides; the page polls), `succeeded`, `failed`.
 */
export type PaymentState = 'idle' | 'starting' | 'ready' | 'paying' | 'waiting' | 'succeeded' | 'failed'

export const PAYMENT_STATES = ['idle', 'starting', 'ready', 'paying', 'waiting', 'succeeded', 'failed'] as const satisfies readonly PaymentState[]

export interface PaymentPanelView {
  /** The region is busy (`aria-busy`): starting, paying, waiting. */
  busy: boolean
  /** The method choice can change (idle, or failed: a new try may take another method). */
  chooseMethod: boolean
  /** The provider's fields (and the mount box) are shown. */
  showFields: boolean
  /** The main button: Continue (idle), Pay (ready), held while paying, none otherwise. */
  action: 'start' | 'pay' | 'paying' | null
  /** The words of the polite status line, by key (`starting`, `paying`, `waiting`), or null. */
  status: 'starting' | 'paying' | 'waiting' | null
}

export interface PaymentViewInput {
  state: PaymentState
  /** The whole panel is held (the page's reason): nothing can start. */
  held?: boolean
  /** The page gives a start step (`onStart`). */
  canStart?: boolean
  /** The page submits through the provider (`onPay`); without it the provider's own fields carry the submit. */
  canPay?: boolean
}

export function paymentPanelView({ state, held = false, canStart = false, canPay = false }: PaymentViewInput): PaymentPanelView {
  const busy = state === 'starting' || state === 'paying' || state === 'waiting'
  const status = state === 'starting' || state === 'paying' || state === 'waiting' ? state : null
  if (held || state === 'succeeded') return { busy: false, chooseMethod: false, showFields: false, action: null, status: null }
  return {
    busy,
    chooseMethod: state === 'idle' || state === 'failed',
    showFields: state === 'ready' || state === 'paying' || state === 'waiting',
    action: state === 'idle' && canStart ? 'start' : state === 'ready' && canPay ? 'pay' : state === 'paying' && canPay ? 'paying' : null,
    status,
  }
}

/** Why Continue is held: no method chosen while there is a choice. Null when it can go. */
export function paymentStartHeld(methods: readonly { id: string }[] | undefined, method: string | null | undefined, pickMethod: string): string | null {
  if (!methods || methods.length === 0) return null
  return method && methods.some((m) => m.id === method) ? null : pickMethod
}

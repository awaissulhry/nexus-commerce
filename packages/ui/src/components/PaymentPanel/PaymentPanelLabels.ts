/**
 * `PaymentPanel`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a value
 * in it is a function.
 */
export interface PaymentPanelLabels {
  /** The amount's label. */
  amount: string
  /** The method choice's legend. */
  method: string
  /** The first step's button (it opens the provider's fields). */
  start: string
  /** The payment's button once the provider's fields are ready: "Pay 714,00 €". */
  pay: (amount: string) => string
  /** The held Start while no method is chosen. */
  pickMethod: string
  /** Opening the provider's fields. */
  starting: string
  /** The payment is on its way to the provider: "Sending to Stripe…". */
  paying: (provider?: string) => string
  /** The provider answered "processing": the bank decides. */
  waiting: string
  /** What a running step's held button says. */
  busy: string
  /** The failed state's title. */
  failedTitle: string
  /** Start again after a failure. */
  retry: string
  /** The paid state's title (when the app gives no words of its own). */
  succeededTitle: string
  /** The region of the provider's own fields: "Payment details, by Stripe". */
  fields: (provider?: string) => string
  /** Under the panel: "Card details go straight to Stripe. We never see them." */
  secure: (provider?: string) => string
}

export const PAYMENT_PANEL_LABELS: PaymentPanelLabels = {
  amount: 'Amount',
  method: 'How do you want to pay?',
  start: 'Continue to payment',
  pay: (amount) => `Pay ${amount}`,
  pickMethod: 'Choose how to pay first.',
  starting: 'Opening the payment…',
  paying: (provider) => (provider ? `Sending to ${provider}…` : 'Sending the payment…'),
  waiting: 'Waiting for your bank… don’t close this page.',
  busy: 'This takes a few seconds.',
  failedTitle: 'The payment did not go through',
  retry: 'Try again',
  succeededTitle: 'Paid',
  fields: (provider) => (provider ? `Payment details, by ${provider}` : 'Payment details'),
  secure: (provider) =>
    provider ? `Card and bank details go straight to ${provider}. We never see them.` : 'Card and bank details go straight to the payment provider. We never see them.',
}

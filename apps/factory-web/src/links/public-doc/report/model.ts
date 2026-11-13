import type { ReportDialogActions, ReportDialogModel } from '../../../lib/safety-reports/dialog'

/**
 * links.doc › sec:report — Report a problem (B-W2b-357; design "The public channel for complaints and accident reports (GPSR)",
 * follow-up GP2:01 "the safety path after the notice"; SAL-414, SAL-415), pure. The section is drawn from the door's state:
 * reading it, OPEN (the button to the form), CLOSED (said honestly: the privacy notice for these reports is not published;
 * whom to write to meanwhile — no door that leads nowhere), or the read failed (Try again). The form is the claim form's
 * safety path, in the shared dialog over the page (lib/safety-reports): tell us, check and send, then the number and the photos.
 */

export type DoorState = 'loading' | 'open' | 'closed' | 'failed'

export interface PublicReportModel {
  readonly door: DoorState
  /** Whom to write to while the door is closed (the page's conversation address). */
  readonly contact: { readonly name: string | null; readonly email: string } | null
  /** The batch the QR names (fixed in the form); null on a style's page (the serial or batch is then asked). */
  readonly batch: string | null
  /** The company keeping the words (the consent names it). */
  readonly keeper: string | null
  readonly today: string
  /** The device's camera reads the label (false in design cases). */
  readonly camera: boolean
  readonly dialog: ReportDialogModel | null
}

export interface PublicReportActions extends ReportDialogActions {
  onRetryDoor?: () => void
  onOpen?: () => void
}

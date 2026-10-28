/**
 * The mail seam of office sign-in (features PLT-015, PLT-070). Invitations and password resets make a single-use link;
 * the API hands a message to the mailer after the command that made the link committed. The mailer is email out's
 * (`emailAuthMailer`, platform/email-out/auth-mail.ts, the default of createOfficeAuth): it composes the mail in memory,
 * records an EmailOutbound row without the body or the link, and sends it through the gateway (SES; a FAKE account's
 * in-memory mailbox in local and test runs, where tests read the link). A link never appears in an API answer, a
 * command result or receipt, an audit row, an event, the gateway ledger or a log.
 *
 * A message lost after the commit (a crash, SES down) is sent again by asking again (a new invitation, a new reset):
 * the link is not stored anywhere it could be sent from later.
 */

export type AuthMessage =
  | {
      readonly kind: 'invitation'
      readonly tenantId: string
      readonly userId: string
      readonly to: string
      /** The accept link, with the token in its fragment (`…/accept-invitation#token=…`). */
      readonly link: string
      readonly expiresAt: Date
      readonly invitedById: string | null
    }
  | {
      readonly kind: 'password_reset'
      readonly tenantId: string
      readonly userId: string
      readonly to: string
      readonly link: string
      readonly expiresAt: Date
    }

export interface AuthMailer {
  deliver(message: AuthMessage): Promise<void>
}

/**
 * The mail seam of office sign-in (features PLT-015, PLT-070). Invitations and password resets make a single-use link;
 * sending it is the email step's job (SES, plan A1 §3.7), which replaces `holdAuthMail` with a mailer that queues an
 * `EmailOutbound` through the outbox. Until then a link leaves the API only through a test's `memoryAuthMailer`: never
 * in an API answer, never in a log.
 *
 * The API hands a message over after the command that made the link committed. A message lost in between (a crash)
 * is sent again by asking again (a new invitation, a new reset); the outbox step makes it part of the transaction.
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

/** No mail transport yet: the message (and its link) is dropped. The email step replaces it. */
export const holdAuthMail: AuthMailer = {
  async deliver() {},
}

const TEST_ONLY = Symbol('factory.memoryAuthMailer')

export interface MemoryAuthMailer extends AuthMailer {
  readonly messages: AuthMessage[]
  /** The newest message of a kind to an address. */
  last(kind: AuthMessage['kind'], to: string): AuthMessage | undefined
}

/** Keeps every message in memory (tests). createOfficeAuth refuses it unless FACTORY_ENV is test. */
export function memoryAuthMailer(): MemoryAuthMailer {
  const messages: AuthMessage[] = []
  const mailer: MemoryAuthMailer = {
    messages,
    async deliver(message) {
      messages.push(message)
    },
    last: (kind, to) => messages.filter((message) => message.kind === kind && message.to === to).at(-1),
  }
  Object.defineProperty(mailer, TEST_ONLY, { value: true })
  return mailer
}

export const isMemoryAuthMailer = (mailer: AuthMailer): boolean => (mailer as unknown as Record<symbol, unknown>)[TEST_ONLY] === true

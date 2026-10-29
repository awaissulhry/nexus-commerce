import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The office sign-in routes' contracts (features PLT-047, PLT-048, PLT-063, PLT-070). Secrets go in bodies, never in a
 * URL (the access log records route patterns only, but a proxy's might record more). Lengths are capped before any
 * hashing; the password's own rules come from factory-domain's auth/password when one is set.
 */

const tenantSlug = z.string().trim().min(1).max(64)
const emailText = z.string().trim().min(3).max(320)
const passwordText = z.string().min(1).max(1024)
const codeText = z.string().trim().min(1).max(32)
export const tokenText = z.string().min(1).max(200)

export const sessionUser = output({ id: id(), email: z.string(), displayName: z.string(), locale: z.string() })
export const mfaView = output({
  /** Two-factor is set up. */
  enabled: z.boolean(),
  /** Two-factor is required for this person (owners, requireMfa). */
  required: z.boolean(),
  /** This session may use the person's permissions (not required, or proved on it). */
  satisfied: z.boolean(),
})
const sessionTimes = output({ idleExpiresAt: instant(), absoluteExpiresAt: instant() })

/** A session started: the cookies are set; the web keeps the CSRF token for the `x-csrf-token` header. */
export const signedInBody = output({ status: z.literal('signed_in'), csrfToken: z.string(), user: sessionUser, mfa: mfaView, session: sessionTimes })

export const signInContract = defineContract({
  body: input({ tenant: tenantSlug, email: emailText, password: passwordText, code: codeText.optional() }),
  response: {
    200: z.discriminatedUnion('status', [
      signedInBody,
      /** The password is right; send it again with a code from the authenticator app (or a recovery code). */
      output({ status: z.literal('totp_required') }),
      /** An administrator required a new password: set it with this token (password reset), then sign in. */
      output({ status: z.literal('password_change_required'), resetToken: z.string(), expiresAt: instant() }),
    ]),
  },
})

export const signOutContract = defineContract({ response: { 200: output({ status: z.literal('signed_out') }) } })

export const meContract = defineContract({
  response: {
    200: output({
      user: sessionUser,
      tenant: output({ id: id(), slug: z.string(), name: z.string() }),
      company: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
      session: sessionTimes.extend({ id: id(), createdAt: instant(), stepUpUntil: instant().nullable() }),
      mfa: mfaView.extend({ recoveryCodesLeft: z.number().int() }),
      /** The screen's company's staff privacy notice in force and whether this person acknowledged it (B-W1-36); null: none. */
      staffNotice: output({ noticeId: id(), label: z.string(), acknowledged: z.boolean() }).nullable(),
      /** What the session's grants allow (the web hides what is not listed). */
      permissions: z.array(z.string()),
    }),
  },
})

export const stepUpContract = defineContract({
  body: input({ code: codeText }),
  response: { 200: output({ stepUpUntil: instant() }) },
})

export const totpSetupContract = defineContract({
  response: { 200: output({ secret: z.string(), otpauthUri: z.string() }) },
})

export const totpConfirmContract = defineContract({
  body: input({ code: codeText }),
  /** Shown once: the web asks the person to keep them. */
  response: { 200: output({ recoveryCodes: z.array(z.string()) }) },
})

export const totpDisableContract = defineContract({
  body: input({ password: passwordText }),
  response: { 200: output({ status: z.literal('off') }) },
})

export const resetRequestContract = defineContract({
  body: input({ tenant: tenantSlug, email: emailText }),
  /** The same answer whether or not the address has an account. */
  response: { 200: output({ status: z.literal('requested') }) },
})

export const resetContract = defineContract({
  body: input({ token: tokenText, password: passwordText }),
  response: { 200: output({ status: z.literal('password_set') }) },
})

export type SignInBody = z.infer<typeof signInContract.body>
export type SignedInBody = z.infer<typeof signedInBody>

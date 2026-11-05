import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LOCALES } from '@nexus/factory-domain/email/rules'
import { proofBody } from '../../abuse/contract'

/**
 * The portal sign-in routes' contracts (B-W2b-159; PLT-050, PLT-066). Codes and tokens go in bodies, never in a URL.
 * Every public route takes an optional `proof` (a solved challenge of GET /abuse/challenge), needed only after it answered
 * 429 with the issue `challenge`.
 */

const tenantSlug = z.string().trim().min(1).max(64)
const companyCode = z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/)
const emailText = z.string().trim().min(3).max(320)
const codeText = z.string().trim().min(1).max(32)
const tokenText = z.string().min(1).max(200)

const portalWho = {
  /** The tenant's slug: whose portal address this is (/p/signin on the company's portal address). */
  tenant: tenantSlug,
  /** The company's code; left out: the tenant's only active company. */
  company: companyCode.optional(),
  email: emailText,
  proof: proofBody.optional(),
}

const sent = output({
  status: z.literal('sent'),
  /** How long the code and the link work, if the address is invited ("They work for 15 minutes"). */
  expiresInSeconds: z.number().int(),
  /** "Send a new code" is held this long (a new code at most once a minute). */
  resendAfterSeconds: z.number().int(),
})

export const startContract = defineContract({
  body: input(portalWho),
  /** The same answer whether or not the address is invited: "If … is invited, we sent a link and a code." */
  response: { 200: sent },
})

const sessionTimes = output({ idleExpiresAt: instant(), absoluteExpiresAt: instant() })

export const signedInBody = output({
  status: z.literal('signed_in'),
  /** The CSRF double-submit token (the browser's, kept): send it as `x-csrf-token` on every unsafe request. */
  csrfToken: z.string(),
  user: output({ id: id(), email: z.string(), displayName: z.string(), locale: z.string() }),
  party: output({ id: id(), name: z.string() }),
  company: output({ id: id(), code: z.string(), name: z.string() }),
  session: sessionTimes,
  /** The first visit asks for the portal terms (POST /portal/first-visit); until then the session may do nothing else. */
  termsDue: z.boolean(),
})

export const codeContract = defineContract({
  body: input({ ...portalWho, code: codeText }),
  response: { 200: signedInBody },
})

export const linkPreviewContract = defineContract({
  body: input({ token: tokenText, proof: proofBody.optional() }),
  /** "Continue to the <Company> portal as anna@brand.example" — reading it does not use the link. */
  response: { 200: output({ company: output({ code: z.string(), name: z.string() }), email: z.string() }) },
})

export const linkContract = defineContract({
  body: input({ token: tokenText, proof: proofBody.optional() }),
  response: { 200: signedInBody },
})

export const signOutContract = defineContract({ response: { 200: output({ status: z.literal('signed_out') }) } })

const termsState = output({ noticeId: id(), label: z.string(), acknowledged: z.boolean() })

export const meContract = defineContract({
  response: {
    200: output({
      user: output({
        id: id(),
        email: z.string(),
        displayName: z.string(),
        locale: z.string(),
        /** CUSTOMER, SUPPLIER, SUBCONTRACTOR or GUEST: which portal (null in an office preview). */
        partnerKind: z.string().nullable(),
        /** The end of access (PLT-022); null: none. */
        accessUntil: instant().nullable(),
      }),
      party: output({ id: id(), name: z.string() }),
      company: output({ id: id(), code: z.string(), name: z.string() }),
      session: sessionTimes.extend({ id: id(), createdAt: instant(), stepUpUntil: instant().nullable() }),
      /** An office person previewing this portal (read-only; B-W2b-162). */
      preview: z.boolean(),
      terms: termsState.nullable(),
      termsDue: z.boolean(),
      /** What the session's grants allow (nothing before the first visit). */
      permissions: z.array(z.string()),
    }),
  },
})

export const refreshContract = defineContract({ response: { 200: sessionTimes } })

export const termsContract = defineContract({
  querystring: input({ locale: z.string().trim().regex(/^[a-z]{2}$/).optional() }),
  response: {
    200: output({
      notice: output({
        id: id(),
        kind: z.literal('PORTAL_TERMS'),
        label: z.string(),
        versionNo: z.number().int(),
        publishedAt: instant().nullable(),
        locale: z.string(),
        body: z.string(),
        /** Send it back with the acknowledgement: it proves which text was shown. */
        sha256: z.string(),
        languages: z.array(z.string()),
        languageReady: z.boolean(),
      }).nullable(),
      acknowledged: z.boolean(),
      means: z.string(),
    }),
  },
})

export const firstVisitContract = defineContract({
  body: input({
    displayName: z.string().trim().min(1).max(120).optional(),
    locale: z.enum(LOCALES).optional(),
    noticeId: id(),
    noticeLocale: z.string().trim().regex(/^[a-z]{2}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  response: { 200: output({ acknowledged: z.literal(true), changed: z.boolean(), label: z.string() }) },
})

export const stepUpStartContract = defineContract({
  response: { 200: output({ status: z.literal('sent'), to: z.string(), expiresInSeconds: z.number().int(), resendAfterSeconds: z.number().int() }) },
})

export const stepUpContract = defineContract({
  body: input({ code: codeText }),
  response: { 200: output({ stepUpUntil: instant() }) },
})

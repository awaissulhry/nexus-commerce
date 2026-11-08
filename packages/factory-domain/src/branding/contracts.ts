import { z } from 'zod'
import { id, input, instant, output } from '../core/contracts'
import { LOGO_CONTENT_TYPES } from './rules'

/**
 * The shapes of the branding routes (apps/factory-api platform/branding; B-W2b-161), shared with the web, which checks
 * every answer against them. Logo addresses are the API's own paths (`/branding/public/<company>/logo/<file>`): the web
 * reaches them through its `/api` prefix like every route.
 */

/** A logo as the office sees it. */
export const brandingLogo = output({
  fileId: id(),
  /** The public path of the picture (rules.ts publicLogoPath). */
  path: z.string(),
  /** The uploaded file's name. */
  name: z.string(),
  contentType: z.enum(LOGO_CONTENT_TYPES),
})
export type BrandingLogo = z.infer<typeof brandingLogo>

/** A company's branding in the office (GET /branding, PUT /branding/:companyId). */
export const brandingView = output({
  companyId: id(),
  /** The company's name as partners know it: its trade name, else its legal name. */
  companyName: z.string(),
  /** A branding row exists (false: every field falls back). */
  saved: z.boolean(),
  logo: brandingLogo.nullable(),
  logoDark: brandingLogo.nullable(),
  /** `#rrggbb`; null: the design system's colours. */
  accentColour: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  portalLabel: z.string().nullable(),
  /** What partners see with the fallbacks applied: the portal's name and the name mail is sent under. */
  shown: output({ portal: z.string(), sender: z.string() }),
  /** The row's version as read (send it back with a change); null before the first save. */
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
  /** documents.branding.manage over the company (a save also asks a fresh step-up). */
  mayChange: z.boolean(),
})
export type BrandingView = z.infer<typeof brandingView>

/** A company's branding for anyone (the portal's sign-in page, the link pages): what the design system's checkBranding takes. */
export const publicBranding = output({
  companyId: id(),
  /** The portal's name: its label, else the company's name. */
  name: z.string(),
  companyName: z.string(),
  /** The public paths of the logos; null: the name in text. A dark logo is null when the light one serves both. */
  logoPath: z.string().nullable(),
  logoDarkPath: z.string().nullable(),
  /** `#rrggbb` as given; the design system uses it only where it passes its contrast rule. */
  accentColour: z.string().nullable(),
})
export type PublicBranding = z.infer<typeof publicBranding>

/** PUT /branding/:companyId: the whole branding, as it should be (every field; null clears it). */
export const brandingBody = input({
  /** The row's version as read; leave it out for a company that has none yet. */
  version: z.number().int().min(1).optional(),
  logoFileId: id().nullable(),
  logoDarkFileId: id().nullable(),
  accentColour: z.string().max(32).nullable(),
  senderDisplayName: z.string().max(400).nullable(),
  portalLabel: z.string().max(400).nullable(),
})
export type BrandingBody = z.infer<typeof brandingBody>

/** POST /branding/:companyId/logo: the picture to upload (its bytes go straight to the store). */
export const logoUploadBody = input({
  originalName: z.string().trim().min(1).max(255),
  contentType: z.string().max(100),
  /** At most LOGO_MAX_BYTES (refused in words by the route). */
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type LogoUploadBody = z.infer<typeof logoUploadBody>

/** The company's legal block as its documents print it (c.c. art. 2250): the name and the lines under it. */
const legalBlock = output({ name: z.string(), lines: z.array(z.string()) })

/**
 * B-W2b-164 (design portal.signin): GET /branding/portal-sign-in — the portal's sign-in page by its address (the tenant's
 * slug and the company's code, as the invitation mail names them) or by the company's id (the mailed link's token names
 * it): whose portal it is (`tenant` + `company.code` are what POST /portal/signin/start takes), its branding, whom to ask
 * (the company's default conversation address) and the legal block of the help foot. Public facts only.
 */
export const portalSignInHead = output({
  tenant: z.string(),
  company: output({ id: id(), code: z.string(), name: z.string() }),
  branding: publicBranding,
  contact: output({ email: z.string().nullable() }),
  legal: output({ it: legalBlock, en: legalBlock }),
})
export type PortalSignInHead = z.infer<typeof portalSignInHead>

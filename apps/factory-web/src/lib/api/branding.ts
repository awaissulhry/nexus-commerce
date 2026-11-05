import { z } from 'zod'
import { publicBranding, type PublicBranding } from '@nexus/factory-domain/branding/contracts'
import type { BrandingTokens } from '@nexus/ui/tokens/branding'
import type { ApiClient } from './client'

/**
 * A company's branding as partners see it (B-W2b-161; apps/factory-api platform/branding), for the views a partner sees
 * before or without an office session: the link frame (`GET /link/branding`, the link's sender) and the portal's
 * sign-in page (`GET /branding/public/:companyId`, before anything is typed). Both answers are checked against
 * factory-domain's own shape and turned into the design system's branding tokens (checkBranding then keeps the colour
 * only where it passes, in each theme). A company without branding gives its name and the standard colours.
 */

const answer = z.object({ branding: publicBranding })

/** The API's logo paths as this browser reaches them (through `/api`, a path on this site: checkBranding keeps it). */
const logoSrc = (path: string | null): string | null => (path ? `/api${path}` : null)

/** The tokens of a branding: `name` is what the page heads with (the portal's name, or the company's for a link). */
export function brandingTokensOf(branding: PublicBranding, name: 'portal' | 'company'): BrandingTokens & { readonly companyId: string } {
  return {
    companyId: branding.companyId,
    name: name === 'portal' ? branding.name : branding.companyName,
    logoUrl: logoSrc(branding.logoPath),
    logoDarkUrl: logoSrc(branding.logoDarkPath),
    accent: branding.accentColour,
  }
}

/** A link session's sender (the link's company): its name, logo and colour. */
export const readLinkBranding = (api: ApiClient): Promise<PublicBranding> => api.get('/link/branding', { schema: answer }).then((read) => read.branding)

/** A company's branding for anyone (the portal's sign-in page). */
export const readPublicBranding = (api: ApiClient, companyId: string): Promise<PublicBranding> =>
  api.get(`/branding/public/${encodeURIComponent(companyId)}`, { schema: answer }).then((read) => read.branding)

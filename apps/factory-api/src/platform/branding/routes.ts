import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../auth/office/account'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../auth/sessions/office-auth'
import { announceLogo, completeLogo, getBranding, linkBranding, publicBranding, publicLogo, saveBranding } from './branding'
import { announceLogoContract, completeLogoContract, getBrandingContract, linkBrandingContract, publicBrandingContract, publicLogoContract, putBrandingContract } from './contract'
import { manifest } from './manifest'

/**
 * Company branding (B-W2b-161; PLT-228, SAL-064; see branding.ts): the office's read and save, the logo's upload, the
 * public read and picture for the portal's sign-in page and the link pages, and a link session's sender.
 */

/** A logo on a portal or link page: up to this many a minute per address (a page draws a logo for light and one for dark). */
const LOGO_RATE = { max: 120, timeWindow: 60_000 } as const
/** A stored file never changes and the address names it: the picture may be kept for good. */
const LOGO_CACHE = 'public, max-age=31536000, immutable'

export default defineRoutes('branding', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/branding', { schema: getBrandingContract }, async (request) => getBranding(request, request.query))
  app.put('/branding/:companyId', { schema: putBrandingContract }, async (request) =>
    saveBranding(request, request.params.companyId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.post('/branding/:companyId/logo', { schema: announceLogoContract }, async (request, reply) => reply.code(201).send(await announceLogo(request, request.params.companyId, request.body, idempotencyKeyFrom(request))))
  app.post('/branding/:companyId/logo/:fileId/complete', { schema: completeLogoContract }, async (request) => completeLogo(request, request.params.companyId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/branding/public/:companyId', { schema: publicBrandingContract, config: limited }, async (request) => publicBranding(request, request.params.companyId))
  app.get('/branding/public/:companyId/logo/:fileId', { schema: publicLogoContract, config: { rateLimit: LOGO_RATE } }, async (request, reply) => {
    const logo = await publicLogo(request, request.params.companyId, request.params.fileId)
    return reply.type(logo.contentType).header('cache-control', LOGO_CACHE).header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').send(logo.bytes)
  })

  app.get('/link/branding', { schema: linkBrandingContract, config: limited }, async (request) => linkBranding(request))
})

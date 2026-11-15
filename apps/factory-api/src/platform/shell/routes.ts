import { defineRoutes } from '../../core/manifest'
import { shellNoticesContract } from './contract'
import { manifest } from './manifest'
import { shellNotices } from './notices'

/** The office shell's notices (B-W2b-F49): what is in test mode where the person works (the TEST MODE banner on every page). */
export default defineRoutes('shell', manifest, async (app) => {
  app.get('/shell/notices', { schema: shellNoticesContract }, async (request) => shellNotices(request, request.query))
})

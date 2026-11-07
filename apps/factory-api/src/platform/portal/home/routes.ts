import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../tasks/clock'
import { homeContract } from './contract'
import { home } from './home'
import { manifest } from './manifest'

/** The partner's Home (B-W2b-167; COL-043; design portal.customer.home, portal.supplier.home, portal.frame rail badges). */
export default defineRoutes('portal-home', manifest, async (app) => {
  app.get('/portal/home', { schema: homeContract }, async (request) => home(app, request, appClock(app).now()))
})

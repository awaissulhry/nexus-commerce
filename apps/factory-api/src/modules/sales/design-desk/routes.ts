import { defineRoutes } from '../../../core/manifest'
import { designDeskContract } from './contract'
import { designDesk } from './desk'
import { manifest } from './manifest'

/** owb-of2: the Design desk (./desk.ts). */
export default defineRoutes('sales.design-desk', manifest, async (app) => {
  app.get('/design-desk', { schema: designDeskContract }, async (request) => designDesk(request))
})

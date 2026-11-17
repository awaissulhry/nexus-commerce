import { defineRoutes } from '../../../core/manifest'
import { serverClock } from '../../../core/time'
import { listIssuesContract } from './contract'
import { listIssues } from './list'
import { manifest } from './manifest'

/** The issues that need an answer (./manifest, B-PR-45): the office's list for the Customer card and the Overview. */
export default defineRoutes('production.issues', manifest, async (app) => {
  app.get('/production/issues', { schema: listIssuesContract }, async (request) => listIssues(request, request.query, serverClock.now()))
})

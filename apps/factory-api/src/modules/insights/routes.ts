import { defineRoutes } from '../../core/manifest'
import { flowContract, todayContract, waitingContract } from './contract'
import { flow } from './flow'
import { manifest } from './manifest'
import { today } from './today'
import { waitingOnOthers } from './waiting'

/**
 * Home › Today (B-W1-52; ANA-037; A2 SCR-029 "Today", SCR-031 W1 "Overview"): the needs-attention list computed from the
 * records' own states (ranked, why each row is mine, what waits on it, tiles per kind), the role's flow strip, and what
 * I wait for from others. Nothing is stored: every answer is read from the modules' records at the moment it is asked.
 */
export default defineRoutes('insights', manifest, async (app) => {
  app.get('/home/today', { schema: todayContract }, async (request) => today(request, request.query))

  app.get('/home/flow', { schema: flowContract }, async (request) => flow(request, request.query))

  app.get('/home/waiting-on-others', { schema: waitingContract }, async (request) => waitingOnOthers(request, request.query))
})

import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createCompanyContract,
  createLineContract,
  createSiteContract,
  createStationContract,
  createWorkCentreContract,
  editCompanyContract,
  editLineContract,
  editSiteContract,
  editStationContract,
  editWorkCentreContract,
  getCompanyContract,
  getSiteContract,
  listCompaniesContract,
} from './contract'
import { manifest } from './manifest'
// B-W2a-41 (PLT-128): the floor languages of the sites.
import { listFloorLanguagesContract, setFloorLanguagesContract } from './contract'
import { listFloorLanguages, setFloorLanguages } from './floor-languages'
import { createCompany, createLine, createSite, createStation, createWorkCentre, editCompany, editLine, editSite, editStation, editWorkCentre, getCompany, getSite, listCompanies } from './org'

/**
 * The tenancy core in the Office (SCR-008 Companies & sites, SCR-009 a site's structure):
 *   GET   /org/companies                    the tree: companies with their sites (and active counts)
 *   POST  /org/companies                    a new company (legal name, code, VAT, country)
 *   GET   /org/companies/:companyId         one company with its sites
 *   PATCH /org/companies/:companyId         legal, e-invoicing and default data; archive
 *   POST  /org/sites                        a new site of a company
 *   GET   /org/sites/:siteId                one site with its lines, work centres and stations
 *   PATCH /org/sites/:siteId                name, kind, time zone, address; archive
 *   POST  /org/sites/:siteId/lines | work-centres | stations
 *   PATCH /org/lines/:id | work-centres/:id | stations/:id
 */
export default defineRoutes('admin-org', manifest, async (app) => {
  app.get('/org/companies', { schema: listCompaniesContract }, async (request) => ({ companies: await listCompanies(request, request.query) }))
  app.post('/org/companies', { schema: createCompanyContract }, async (request, reply) =>
    reply.code(201).send({ company: await createCompany(request, request.body, idempotencyKeyFrom(request)) }),
  )
  app.get('/org/companies/:companyId', { schema: getCompanyContract }, async (request) => getCompany(request, request.params.companyId))
  app.patch('/org/companies/:companyId', { schema: editCompanyContract }, async (request) => ({
    company: await editCompany(request, request.params.companyId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/org/sites', { schema: createSiteContract }, async (request, reply) => reply.code(201).send({ site: await createSite(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/org/sites/:siteId', { schema: getSiteContract }, async (request) => getSite(request, request.params.siteId))
  app.patch('/org/sites/:siteId', { schema: editSiteContract }, async (request) => ({ site: await editSite(request, request.params.siteId, request.body, idempotencyKeyFrom(request)) }))

  app.post('/org/sites/:siteId/lines', { schema: createLineContract }, async (request, reply) =>
    reply.code(201).send({ line: await createLine(request, request.params.siteId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/org/lines/:lineId', { schema: editLineContract }, async (request) => ({ line: await editLine(request, request.params.lineId, request.body, idempotencyKeyFrom(request)) }))

  app.post('/org/sites/:siteId/work-centres', { schema: createWorkCentreContract }, async (request, reply) =>
    reply.code(201).send({ workCentre: await createWorkCentre(request, request.params.siteId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/org/work-centres/:workCentreId', { schema: editWorkCentreContract }, async (request) => ({
    workCentre: await editWorkCentre(request, request.params.workCentreId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/org/sites/:siteId/stations', { schema: createStationContract }, async (request, reply) =>
    reply.code(201).send({ station: await createStation(request, request.params.siteId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/org/stations/:stationId', { schema: editStationContract }, async (request) => ({
    station: await editStation(request, request.params.stationId, request.body, idempotencyKeyFrom(request)),
  }))

  // B-W2a-41 (PLT-128): the languages each site's tablets offer workers.
  app.get('/org/floor-languages', { schema: listFloorLanguagesContract }, async (request) => ({ sites: await listFloorLanguages(request, request.query) }))
  app.put('/org/sites/:siteId/floor-languages', { schema: setFloorLanguagesContract }, async (request) => ({
    site: await setFloorLanguages(request, request.params.siteId, request.body, idempotencyKeyFrom(request)),
  }))
})

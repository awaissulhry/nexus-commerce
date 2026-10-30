import { defineManifest } from '../../../core/manifest'

/**
 * The tenancy core in the Office (SCR-008, SCR-009; PLT-003, PLT-004, MES-292). Companies, sites and their structure
 * are scoped by record: the handlers check each row with can() against its company (and site) and filter the lists
 * with scopeWhere(). A new company needs companies.manage over every company.
 */
export const manifest = defineManifest({
  'GET /org/companies': { audiences: ['office'], permission: 'companies.view', scope: 'record' },
  'POST /org/companies': { audiences: ['office'], permission: 'companies.manage', scope: 'record' },
  'GET /org/companies/:companyId': { audiences: ['office'], permission: 'companies.view', scope: 'record' },
  'PATCH /org/companies/:companyId': { audiences: ['office'], permission: 'companies.manage', scope: 'record' },
  'POST /org/sites': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'GET /org/sites/:siteId': { audiences: ['office'], permission: 'sites.view', scope: 'record' },
  'PATCH /org/sites/:siteId': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'POST /org/sites/:siteId/lines': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'PATCH /org/lines/:lineId': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'POST /org/sites/:siteId/work-centres': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'PATCH /org/work-centres/:workCentreId': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'POST /org/sites/:siteId/stations': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'PATCH /org/stations/:stationId': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  // B-W2a-41 (PLT-128): the floor languages (each site checked with can(); an added language needs the worker notice in it).
  'GET /org/floor-languages': { audiences: ['office'], permission: 'sites.view', scope: 'record' },
  'PUT /org/sites/:siteId/floor-languages': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
})

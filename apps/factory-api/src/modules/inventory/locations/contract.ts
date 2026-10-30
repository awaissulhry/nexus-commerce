import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LOCATION_KINDS, LOCATION_STATUSES } from '@nexus/factory-domain/inventory/locations/rules'

/**
 * The locations' contracts (SCM-176, SCM-177, SCM-178; A2 SCR-065). A code is upper case (a typed one is upper-cased),
 * unique on its site and never changes (it is printed on the bin label). No field carries money.
 */

const kind = z.enum(LOCATION_KINDS)
const version = () => z.number().int().min(1)

export const locationView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  parentId: id().nullable(),
  code: z.string(),
  name: z.string(),
  kind,
  /** B-W2a-25 (SCM-141): the workshop whose stock place it is, exactly for a SUBCONTRACTOR location. */
  partyId: id().nullable(),
  status: z.enum(LOCATION_STATUSES),
  /** 0 at the top of the site's tree. */
  depth: z.number().int(),
  /** The codes from the top of the tree down to this one. */
  path: z.array(z.string()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type LocationView = z.infer<typeof locationView>

export const siteLocations = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  /** In tree order: depth first, children by code. */
  locations: z.array(locationView),
})
export type SiteLocations = z.infer<typeof siteLocations>

const one = { 200: output({ location: locationView }) }
const params = input({ locationId: id() })

export const listLocationsContract = defineContract({
  querystring: input({
    /** One site (a floor device: only its own). */
    siteId: id().optional(),
    /** Archived locations too. */
    includeArchived: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: { 200: output({ sites: z.array(siteLocations) }) },
})

export const createLocationContract = defineContract({
  body: input({
    siteId: id(),
    /** The location it sits inside, on the same site; none at the top. */
    parentId: id().nullish(),
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    kind,
    /** B-W2a-25: the workshop (a party with the SUBCONTRACTOR role), required for and only for kind SUBCONTRACTOR. */
    partyId: id().nullish(),
  }),
  response: { 201: output({ location: locationView }) },
})

export const updateLocationContract = defineContract({
  params,
  body: input({ version: version(), name: z.string().trim().min(1).max(120).optional(), kind: kind.optional() }),
  response: one,
})

export const moveLocationContract = defineContract({
  params,
  body: input({ version: version(), parentId: id().nullable() }),
  response: one,
})

export const archiveLocationContract = defineContract({
  params,
  body: input({ version: version() }),
  response: one,
})

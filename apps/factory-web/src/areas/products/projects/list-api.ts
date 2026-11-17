import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The list's and New project's own reads beside the projects' routes (B-TH-248): the outside companies to pick (GET /parties,
 * parties.view) and the company's open seasons (GET /sales/seasons). Checked here; the words are the screens'.
 */

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), roles: z.array(z.string()) })
export type PartyOption = z.infer<typeof partyOption>

/** A customer, a brand, a supplier or a subcontractor of this company (or of every company): a project's outside company. */
export function listOutsideCompanies(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> {
  return api
    .get('/parties', { query: { role: 'CUSTOMER,BRAND,SUPPLIER,SUBCONTRACTOR', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
    .then((answer) => answer.parties)
}

const season = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type SeasonOption = z.infer<typeof season>

/** The company's open seasons (a project may name one by its code). */
export function listSeasons(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<SeasonOption[]> {
  return api.get('/sales/seasons', { query: { companyId, status: 'OPEN' }, schema: z.object({ seasons: z.array(season) }), signal }).then((answer) => answer.seasons)
}

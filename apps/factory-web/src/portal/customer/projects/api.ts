import { z } from 'zod'
import { PROJECT_STATUSES } from '@nexus/factory-domain/projects/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * What the portal reads of projects (threads plan TH-5, B-TH-253 on the API's B-TH-069 / B-TH-072; design PROJ.portal): the
 * projects of the portal's company the person was ADDED to by the factory (GET /portal/projects — members only, open first, then
 * by target date) and a project's linked news (GET /portal/projects/:projectId/news — only the records the person opens in their
 * own portal, status moves only, never who did it). The conversation itself is the portal's record thread (GET
 * /portal/threads/Project/:id, read by PortalThread). Each answer is checked; the web reads only what it uses. The API sends the
 * office's project number too: the portal never draws it (an office series counts every customer's projects, B-TH-303).
 */

export const portalProjectSchema = z.object({
  id: z.string(),
  /** The office's project number (PRJ-26-012): kept to match a conversation, never drawn in the portal. */
  number: z.string(),
  name: z.string(),
  status: z.enum(PROJECT_STATUSES),
  /** YYYY-MM-DD. */
  targetDate: z.string(),
})
export type PortalProject = z.infer<typeof portalProjectSchema>

/** GET /portal/projects: the person's own projects (an empty list for a person the office added to none). */
export const fetchPortalProjects = (api: ApiClient, signal?: AbortSignal): Promise<PortalProject[]> =>
  api.get('/portal/projects', { schema: z.object({ projects: z.array(portalProjectSchema) }), signal }).then((answer) => answer.projects)

export const newsEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  /** The person's own reference of the record (their PO), and ours as their portal shows it. */
  theirRef: z.string().nullable(),
  ourRef: z.string().nullable(),
  status: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  /** How many moves of the record that day the line stands for. */
  folded: z.number().int(),
})
export type NewsEntry = z.infer<typeof newsEntrySchema>

const newsSchema = z.object({ entries: z.array(newsEntrySchema), nextCursor: z.string().nullable() })
export type NewsPage = z.infer<typeof newsSchema>

/** The most news lines one read asks (the page shows a page; "Show older" reads the next). */
export const NEWS_PAGE = 20

/** GET /portal/projects/:projectId/news: a member's news of the records linked to the project it opens itself. */
export const fetchProjectNews = (api: ApiClient, projectId: string, cursor?: string | null, signal?: AbortSignal): Promise<NewsPage> =>
  api.get(`/portal/projects/${encodeURIComponent(projectId)}/news`, { query: { limit: NEWS_PAGE, ...(cursor ? { cursor } : {}) }, schema: newsSchema, signal })

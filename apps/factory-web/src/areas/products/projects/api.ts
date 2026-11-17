import { z } from 'zod'
import { FOLLOW_REASONS } from '@nexus/factory-domain/threads/followers'
import { PROJECT_OUTCOMES, PROJECT_STATUSES, type ProjectMove, type ProjectOutcome } from '@nexus/factory-domain/projects/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Products › Development › Projects (threads plan TH-5, B-TH-248 … B-TH-252; the API's modules/product/projects,
 * B-TH-066 … B-TH-072): the list, the project page, its record moves, linked records, people, linked news, My projects and
 * "In project" of any record. Each answer is checked here (zod drops unknown fields; the API's contract lives in the API, so the
 * shapes are written once more here, the read side only). Every write carries the project's version where the API asks it and one
 * Idempotency-Key per attempt. The API's words (`statusWords`, `target.words`, `openToOfficeWords`, a refusal's message) are never
 * shown: the screens say their own words from the codes and facts (model.ts). No money anywhere.
 */

const enc = encodeURIComponent
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

const person = z.object({ id: z.string(), name: z.string() })
const status = z.enum(PROJECT_STATUSES)
const target = z.object({ state: z.string(), days: z.number().int() })

// ---- the project ---------------------------------------------------------------------------------------------------------------

export const projectSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  companyId: z.string(),
  company: z.object({ id: z.string(), code: z.string() }),
  /** The ONE outside company, chosen at creation and never changed; null: office only. */
  party: z.object({ id: z.string(), code: z.string(), name: z.string(), roles: z.array(z.string()) }).nullable(),
  lead: person,
  seasonCode: z.string().nullable(),
  /** YYYY-MM-DD. */
  targetDate: z.string(),
  /** OVERDUE (red) · SOON (amber, within 7 days) · LATER · CLOSED (plain), with the days from today. */
  target,
  status,
  outcome: z.enum(PROJECT_OUTCOMES).nullable(),
  outcomeNote: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: person.nullable(),
  createdAt: z.string(),
  createdBy: person.nullable(),
  lastMessageAt: z.string().nullable(),
  threadStatus: z.string().nullable(),
  version: z.number().int(),
  officeOnly: z.boolean(),
  /** What the reader may do: keep it (projects.manage), write and add a colleague (threads.post), the moves allowed now. */
  may: z.object({ manage: z.boolean(), post: z.boolean(), moves: z.array(z.string()) }),
})
export type ProjectView = z.infer<typeof projectSchema>
const oneProject = z.object({ project: projectSchema })

// ---- the list ------------------------------------------------------------------------------------------------------------------

export const projectRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  companyId: z.string(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  lead: person,
  status,
  targetDate: z.string(),
  target,
  seasonCode: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  /** The reader's OWN unread notifications of it (0 when muted); never anyone else's. */
  newForMe: z.number().int(),
  muted: z.boolean(),
  /** I am one of its people (any reason). */
  mine: z.boolean(),
  linked: z.number().int(),
  version: z.number().int(),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

const projectList = z.object({ rows: z.array(projectRowSchema), count: z.number().int(), next: z.string().nullable(), complete: z.boolean() })
export type ProjectList = z.infer<typeof projectList>

/** The API's views (MINE is its default), sorts and target filters (modules/product/projects/list.ts). */
export const API_VIEWS = ['MINE', 'ACTIVE', 'ON_HOLD', 'CLOSED', 'ALL'] as const
export type ApiView = (typeof API_VIEWS)[number]
export const API_SORTS = ['TARGET', 'PARTY', 'RECENT'] as const
export type ApiSort = (typeof API_SORTS)[number]
export const API_TARGETS = ['OVERDUE', 'THIS_MONTH'] as const
export type ApiTarget = (typeof API_TARGETS)[number]

export interface ProjectQuery {
  readonly view?: ApiView | null
  readonly companyId?: string | null
  readonly partyId?: string | null
  /** Office-only projects. */
  readonly officeOnly?: boolean
  readonly leadId?: string | null
  readonly seasonCode?: string | null
  readonly target?: ApiTarget | null
  readonly q?: string | null
  readonly sort?: ApiSort | null
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /projects: a page of the list (50 by default; the next page by `cursor`). */
export function listProjects(api: ApiClient, query: ProjectQuery, signal?: AbortSignal): Promise<ProjectList> {
  return api.get('/projects', {
    query: {
      view: query.view ?? undefined,
      companyId: query.companyId ?? undefined,
      partyId: query.officeOnly ? undefined : (query.partyId ?? undefined),
      outside: query.officeOnly ? 'none' : undefined,
      leadId: query.leadId ?? undefined,
      seasonCode: query.seasonCode?.trim() || undefined,
      target: query.target ?? undefined,
      q: query.q?.trim() || undefined,
      sort: query.sort ?? undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: projectList,
    signal,
  })
}

/** GET /projects/mine: Today's "My projects" (the open projects I am in, my own new marks, whether I lead it). */
const mineSchema = z.object({ projects: z.array(projectRowSchema.extend({ lead: person.extend({ me: z.boolean() }) })) })
export type MyProject = z.infer<typeof mineSchema>['projects'][number]
export function myProjects(api: ApiClient, signal?: AbortSignal): Promise<MyProject[]> {
  return api.get('/projects/mine', { schema: mineSchema, signal }).then((answer) => answer.projects)
}

/** GET /projects/counts?partyId: a company band's "Projects (n)" (its open projects the reader reads). */
export function projectCounts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<{ open: number; all: number }> {
  return api.get('/projects/counts', { query: { partyId }, schema: z.object({ open: z.number().int(), all: z.number().int() }), signal })
}

const shortProject = z.object({ id: z.string(), number: z.string(), name: z.string(), status })
export type ShortProject = z.infer<typeof shortProject>

/** GET /projects/similar: the New project dialog's duplicate warning (active projects with a name alike, of that company). */
export function similarProjects(api: ApiClient, query: { companyId: string; partyId?: string | null; name: string }, signal?: AbortSignal): Promise<ShortProject[]> {
  return api
    .get('/projects/similar', { query: { companyId: query.companyId, partyId: query.partyId ?? undefined, name: query.name.trim() }, schema: z.object({ projects: z.array(shortProject) }), signal })
    .then((answer) => answer.projects)
}

/** GET /projects/of/:type/:id: "In project …" of any record (only the projects the reader may open). */
export function projectsOfRecord(api: ApiClient, record: { type: string; id: string }, signal?: AbortSignal): Promise<{ count: number; projects: ShortProject[] }> {
  return api.get(`/projects/of/${enc(record.type)}/${enc(record.id)}`, { schema: z.object({ count: z.number().int(), projects: z.array(shortProject) }), signal })
}

// ---- the page ------------------------------------------------------------------------------------------------------------------

export const linkedRecordSchema = z.object({
  linkId: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  /** STYLES · SAMPLES · QUOTES · ORDERS · REQUESTS · SHIPMENTS · CHANGES · PURCHASE_ORDERS · CERTIFICATES · MEASUREMENTS. */
  group: z.string(),
  /** Null when the reader may not open the record ("you cannot open it"). */
  label: z.string().nullable(),
  status: z.string().nullable(),
  mayOpen: z.boolean(),
  note: z.string().nullable(),
  linkedAt: z.string(),
  linkedBy: person.nullable(),
})
export type LinkedRecord = z.infer<typeof linkedRecordSchema>
export const linksSchema = z.object({ count: z.number().int(), records: z.array(linkedRecordSchema) })
export type ProjectLinks = z.infer<typeof linksSchema>

const reason = z.enum(FOLLOW_REASONS)
export const peopleSchema = z.object({
  office: z.object({
    count: z.number().int(),
    people: z.array(z.object({ userId: z.string(), name: z.string(), lead: z.boolean(), me: z.boolean(), reason, addedBy: person.nullable(), muted: z.boolean(), since: z.string() })),
  }),
  outside: z.object({ count: z.number().int(), people: z.array(z.object({ userId: z.string(), name: z.string(), reason, addedBy: person.nullable(), since: z.string() })) }),
  invited: z.object({ count: z.number().int(), people: z.array(z.object({ shareId: z.string(), name: z.string().nullable(), email: z.string(), until: z.string(), permissions: z.array(z.string()) })) }),
})
export type ProjectPeople = z.infer<typeof peopleSchema>

const pageSchema = z.object({
  project: projectSchema,
  people: peopleSchema,
  links: linksSchema,
  tasks: z.object({ open: z.number().int(), overdue: z.number().int() }),
  files: z.object({ count: z.number().int() }),
  me: z.object({ following: z.boolean(), muted: z.boolean(), reason: reason.nullable() }),
})
export type ProjectPage = z.infer<typeof pageSchema>

/** GET /projects/:id: the project, its people, its linked records, its tasks and files (counts), my follow. 404 when not mine to read. */
export function readProject(api: ApiClient, projectId: string, signal?: AbortSignal): Promise<ProjectPage> {
  return api.get(`/projects/${enc(projectId)}`, { schema: pageSchema, signal })
}

// ---- B-TH-066: the record ------------------------------------------------------------------------------------------------------

export interface CreateProjectBody {
  readonly companyId: string
  readonly name: string
  /** Chosen now, never changed; null: an office-only project. */
  readonly partyId: string | null
  readonly leadId: string
  readonly targetDate: string
  readonly seasonCode?: string | null
  readonly goal?: string | null
  readonly colleagueIds?: readonly string[]
  readonly links?: readonly { readonly recordType: string; readonly recordId: string; readonly note?: string | null }[]
}

/** POST /projects: a new project (numbered from the company's PROJECT series; its maker, lead and colleagues are its people). */
export function createProject(api: ApiClient, body: CreateProjectBody, idempotencyKey?: string): Promise<ProjectView> {
  return api.post('/projects', { body, schema: oneProject, ...key(idempotencyKey) }).then((answer) => answer.project)
}

export interface UpdateProjectBody {
  readonly version: number
  readonly name?: string
  readonly goal?: string | null
  readonly leadId?: string
  readonly targetDate?: string
  readonly seasonCode?: string | null
}

/** PATCH /projects/:id: name, goal, lead, target date, season (never the outside company), with the version read. */
export function updateProject(api: ApiClient, projectId: string, body: UpdateProjectBody, idempotencyKey?: string): Promise<ProjectView> {
  return api.request('PATCH', `/projects/${enc(projectId)}`, { body, schema: oneProject, ...key(idempotencyKey) }).then((answer) => answer.project)
}

const MOVE_PATH: Readonly<Record<Exclude<ProjectMove, 'CLOSE'>, string>> = { HOLD: 'hold', RESUME: 'resume', REOPEN: 'reopen' }

/** POST /projects/:id/hold | resume | reopen, with the version read. */
export function moveProject(api: ApiClient, projectId: string, move: Exclude<ProjectMove, 'CLOSE'>, version: number, idempotencyKey?: string): Promise<ProjectView> {
  return api.post(`/projects/${enc(projectId)}/${MOVE_PATH[move]}`, { body: { version }, schema: oneProject, ...key(idempotencyKey) }).then((answer) => answer.project)
}

export interface CloseProjectBody {
  readonly version: number
  readonly outcome: ProjectOutcome
  /** The one outcome line (posted and pinned). */
  readonly outcomeNote: string
  /** Post the outcome to the outside company too (only a project with one). */
  readonly tellCustomer?: boolean
}

/** POST /projects/:id/close: Done or Stopped with one line; the thread closes and every open invitation ends. */
export function closeProject(api: ApiClient, projectId: string, body: CloseProjectBody, idempotencyKey?: string): Promise<ProjectView> {
  return api.post(`/projects/${enc(projectId)}/close`, { body, schema: oneProject, ...key(idempotencyKey) }).then((answer) => answer.project)
}

// ---- B-TH-067: linked records ------------------------------------------------------------------------------------------------

/** POST /projects/:id/links: link one record (the wall: same company, same outside company or none). */
export function linkRecord(api: ApiClient, projectId: string, body: { recordType: string; recordId: string; note?: string | null }, idempotencyKey?: string): Promise<ProjectLinks> {
  return api
    .post(`/projects/${enc(projectId)}/links`, { body, schema: z.object({ link: z.object({ id: z.string(), recordType: z.string(), recordId: z.string() }), links: linksSchema }), ...key(idempotencyKey) })
    .then((answer) => answer.links)
}

const manyAnswer = z.object({ linked: z.number().int(), skipped: z.array(z.object({ recordId: z.string(), code: z.string() })), links: linksSchema })
export type LinkManyAnswer = z.infer<typeof manyAnswer>

/** POST /projects/:id/links/bulk: the Styles and Samples lists' "Add to project" — the rows that may join, the others with their code. */
export function linkMany(api: ApiClient, projectId: string, body: { recordType: 'Style' | 'SampleRound'; recordIds: readonly string[]; note?: string | null }, idempotencyKey?: string): Promise<LinkManyAnswer> {
  return api.post(`/projects/${enc(projectId)}/links/bulk`, { body, schema: manyAnswer, ...key(idempotencyKey) })
}

/** DELETE /projects/:id/links/:linkId: unlink (a system line says who). */
export function unlinkRecord(api: ApiClient, projectId: string, linkId: string, idempotencyKey?: string): Promise<ProjectLinks> {
  return api.request('DELETE', `/projects/${enc(projectId)}/links/${enc(linkId)}`, { schema: z.object({ links: linksSchema }), ...key(idempotencyKey) }).then((answer) => answer.links)
}

// ---- B-TH-068: people ------------------------------------------------------------------------------------------------------------

const peopleAnswer = z.object({ people: peopleSchema })

/** GET /projects/:id/people. */
export function readPeople(api: ApiClient, projectId: string, signal?: AbortSignal): Promise<ProjectPeople> {
  return api.get(`/projects/${enc(projectId)}/people`, { schema: peopleAnswer, signal }).then((answer) => answer.people)
}

const choicesSchema = z.object({ office: z.array(z.object({ userId: z.string(), name: z.string() })), outside: z.array(z.object({ userId: z.string(), name: z.string() })), mayAddOutside: z.boolean() })
export type PeopleChoices = z.infer<typeof choicesSchema>

/** GET /projects/:id/people/choices: office colleagues who may read it and are not in it; the outside company's portal people (projects.manage). */
export function peopleChoices(api: ApiClient, projectId: string, q?: string, signal?: AbortSignal): Promise<PeopleChoices> {
  return api.get(`/projects/${enc(projectId)}/people/choices`, { query: { q: q?.trim() || undefined }, schema: choicesSchema, signal })
}

/** POST /projects/:id/people: add a colleague (told) or one of the outside company's portal people (projects.manage). */
export function addPerson(api: ApiClient, projectId: string, userId: string, idempotencyKey?: string): Promise<ProjectPeople> {
  return api.post(`/projects/${enc(projectId)}/people`, { body: { userId }, schema: peopleAnswer, ...key(idempotencyKey) }).then((answer) => answer.people)
}

/** DELETE /projects/:id/people/:userId: the lead (or projects.manage) takes a person out; the lead stays. */
export function removePerson(api: ApiClient, projectId: string, userId: string, idempotencyKey?: string): Promise<ProjectPeople> {
  return api.request('DELETE', `/projects/${enc(projectId)}/people/${enc(userId)}`, { schema: peopleAnswer, ...key(idempotencyKey) }).then((answer) => answer.people)
}

// ---- B-TH-072: linked news (asked only, never in the default feed) ---------------------------------------------------------

const linkedNewsEntry = z.object({
  kind: z.literal('linked'),
  id: z.string(),
  at: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  label: z.string(),
  action: z.string(),
  status: z.object({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  actorName: z.string().nullable(),
  folded: z.number().int(),
})
export type LinkedNewsEntry = z.infer<typeof linkedNewsEntry>

/** GET /threads/Project/:id/timeline?kinds=linked: the linked records' moves and decisions, merged when read (one line per record per day). */
export function readLinkedNews(api: ApiClient, projectId: string, cursor?: string | null, signal?: AbortSignal): Promise<{ entries: LinkedNewsEntry[]; nextCursor: string | null }> {
  return api
    .get(`/threads/Project/${enc(projectId)}/timeline`, {
      query: { kinds: 'linked', cursor: cursor ?? undefined, limit: 30 },
      // Only `linked` entries were asked; anything else is left out rather than failing the read.
      schema: z.object({ entries: z.array(z.unknown()), nextCursor: z.string().nullable() }),
      signal,
    })
    .then((answer) => ({ entries: answer.entries.flatMap((entry) => { const parsed = linkedNewsEntry.safeParse(entry); return parsed.success ? [parsed.data] : [] }), nextCursor: answer.nextCursor }))
}

// ---- B-TH-071: "Start a project" from an Incoming request --------------------------------------------------------------------

export interface StartFromRequestBody {
  readonly name?: string
  readonly targetDate: string
  readonly leadId?: string
  readonly goal?: string | null
  readonly seasonCode?: string | null
  readonly colleagueIds?: readonly string[]
  readonly fileIds?: readonly string[]
}

/** POST /sales/inquiries/:id/project: the request's customer is the project's (never one typed); the request is linked, its files carried. */
export function startProjectFromRequest(api: ApiClient, inquiryId: string, body: StartFromRequestBody, idempotencyKey?: string): Promise<ProjectView> {
  return api.post(`/sales/inquiries/${enc(inquiryId)}/project`, { body, schema: z.object({ project: projectSchema }), ...key(idempotencyKey) }).then((answer) => answer.project)
}

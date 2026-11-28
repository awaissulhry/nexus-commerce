import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { pictureSchema } from '../../../lib/people-picture/schema'

/**
 * owb-ss7 (S3 web B; the server Shape of owb-ss5, FIXED) — the reads and writes of Production › Teams, "Give to a team…" and the
 * order's Team part, with the answers checked (zod; unknown fields are dropped, so a new field never breaks a screen).
 *
 *   GET  /production/orders/:orderId/teams        the teams of one order (rows, mode, the planned baskets, printed, may)
 *   PUT  /production/orders/:orderId/teams        the rows as the window saves them (version-checked) → the same answer
 *   POST /production/orders/:orderId/team-asks    sales asks for another team (why) → a task to the production managers
 *   GET  /production/teams/board?siteId=          one column a team + "No team yet"; the teams for "Give to a team…"
 *
 * Privacy (the real app's rule, design § 5za): every figure is a TEAM's, and the API sends null for a team below the people
 * settings' minimum group; the screen shows "—", never a figure of its own. No name of a customer: the floor's customer CODE only.
 * The API's English is never drawn: words come from codes and kinds (model.ts).
 */

const count = z.number().int().min(0)
const person = z.object({ employeeId: z.string(), name: z.string() })

export const teamFaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  picture: pictureSchema,
  leader: person.nullable(),
  people: count.nullable(),
})
export type TeamFace = z.infer<typeof teamFaceSchema>

export const ORDER_TEAM_MODES = ['NONE', 'ONE', 'TOGETHER', 'SPLIT'] as const
export type OrderTeamMode = (typeof ORDER_TEAM_MODES)[number]

const factsSchema = z.object({
  inWork: count.nullable(),
  maxBaskets: count.nullable(),
  workedForCustomer: z.boolean(),
  takesNewOrders: z.boolean(),
  overLimit: z.boolean(),
  missingToday: count.nullable(),
  late: count.nullable(),
})
export type TeamFacts = z.infer<typeof factsSchema>

const orderTeamRowSchema = z.object({
  team: teamFaceSchema,
  inCharge: z.boolean(),
  basketShare: count.nullable(),
  givenBy: z.enum(['USER', 'RULE']).catch('USER'),
  facts: factsSchema,
})
export type OrderTeamRow = z.infer<typeof orderTeamRowSchema>

const orderTeamsSchema = z.object({
  orderId: z.string(),
  version: z.number().int(),
  printed: z.boolean(),
  mode: z.enum(ORDER_TEAM_MODES).catch('NONE'),
  plannedBaskets: count,
  rows: z.array(orderTeamRowSchema),
  may: z.object({ give: z.boolean(), ask: z.boolean() }),
})
export type OrderTeams = z.infer<typeof orderTeamsSchema>

/** One row as the window sends it: a team once, ONE in charge, a share only when the baskets are split. */
export interface OrderTeamPut {
  readonly teamId: string
  readonly inCharge: boolean
  readonly basketShare: number | null
}

const seg = (value: string): string => encodeURIComponent(value)

export const getOrderTeams = (api: ApiClient, orderId: string, signal?: AbortSignal) => api.get(`/production/orders/${seg(orderId)}/teams`, { schema: orderTeamsSchema, signal })

export const putOrderTeams = (api: ApiClient, orderId: string, body: { version: number; rows: readonly OrderTeamPut[]; why?: string }) =>
  api.request('PUT', `/production/orders/${seg(orderId)}/teams`, { body, schema: orderTeamsSchema, idempotencyKey: newIdempotencyKey() })

export const askAnotherTeam = (api: ApiClient, orderId: string, why: string) =>
  api.post(`/production/orders/${seg(orderId)}/team-asks`, { body: { why }, schema: z.object({ taskId: z.string() }), idempotencyKey: newIdempotencyKey() })

const boardOrderSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  customerCode: z.string(),
  baskets: count.nullable(),
  inCharge: z.boolean(),
  due: z.string().nullable(),
  late: z.boolean(),
})
export type BoardOrder = z.infer<typeof boardOrderSchema>

const boardColumnSchema = z.object({
  /** null = the column "No team yet". */
  team: teamFaceSchema.nullable(),
  load: z.object({ inWork: count.nullable(), maxBaskets: count.nullable() }),
  /** Mark codes (words on the web): OVER_LIMIT · NO_NEW_ORDERS · MISSING_TODAY[:n] · LATE[:n] (model.ts marksOf). */
  marks: z.array(z.string()),
  orders: z.array(boardOrderSchema),
})
export type BoardColumn = z.infer<typeof boardColumnSchema>

const boardSchema = z.object({
  columns: z.array(boardColumnSchema),
  teams: z.array(teamFaceSchema.extend({ takesNewOrders: z.boolean() })),
})
export type TeamsBoard = z.infer<typeof boardSchema>
export type BoardTeam = TeamsBoard['teams'][number]

/** The board of a site (a team works on one site); without a site the API answers the person's own sites. */
export const getTeamsBoard = (api: ApiClient, siteId: string | null, signal?: AbortSignal) =>
  api.get('/production/teams/board', { query: siteId ? { siteId } : {}, schema: boardSchema, signal })

import { writeFileSync } from 'node:fs'
import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify'
import { z } from 'zod'
import type { MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
// The factory-db schema reader is no package export: a test reads it where it lives.
import { readSchemaFolder, type SchemaModel } from '../../../../../../packages/factory-db/src/schema-models'
import type { RouteManifestEntry } from '../../../core/manifest'
import { findMarkers, markersOf, walkWorkOrderRoutes, type Marker, type OfficeSession, type ProductionTwoBrands, type WalkedRoute } from './two-brands'

/**
 * B-PR-10 — THE BRAND-WALL SWEEP's engine (production plan §2 "Proof": "a sweep of every route, reads AND writes, that touches
 * work orders"; Appendix D PW-10). Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand.
 * But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * B-PR-36: moved here from `../brand-wall.pg.vitest.test.ts` (unchanged) so the production golden flow re-runs the same sweep
 * on its own world at the end (a test file cannot be imported: its tests would run again). Each test file makes its own
 * sweep (`createWallSweep`), registers `routeSpy` first on the app the sweep calls, builds its world, then `prepare`s.
 *
 * Each swept route is called as the `reader` session — every office permission, limited to brand B — with brand A's ids in its
 * address, its query and its body, and again with a fresh id in place of each of A's (an unknown record):
 *   - A's answer is word for word the unknown one's (status and words; the request id and the asked ids aside), or a 403 in
 *     EVERY_PARTY words: another customer's record is not found, a view that mixes customers needs every customer;
 *   - a write with A's ids is refused (never 2xx while the unknown one is refused) and writes no audit row about A;
 *   - no answer names anything of A (the threads' marker scan: names, codes, numbers, references, ids — the ids the reader itself
 *     sent are left out) — also on a route whose request names nothing of A (a list, a board, a report).
 * The production unit (`everyone`, the same permissions, every customer) reads the same GET addresses: how many it reaches is
 * counted (the sweep proves the wall on real records, not on ids that exist nowhere).
 */

export type Json = Record<string, any>
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteFacts {
  readonly method: Method
  readonly url: string
  readonly manifest: RouteManifestEntry
  readonly params?: unknown
  readonly querystring?: unknown
  readonly body?: unknown
}

export interface Finding {
  readonly route: string
  readonly url: string
  readonly what: string
}

export interface Called {
  readonly route: string
  readonly url: string
  readonly a: number
  readonly fresh: number | null
  readonly all: number | null
  readonly named: number
  readonly verdict: string
}

/**
 * Routes the walker lists that the sweep does not call, each with its reason. Office routes only are swept: a floor device
 * reaches every customer of its site by design (plan §2: floor screens show the customer code), partner and link sessions are
 * fixed to their own party by the session (row-level security), the platform has no tenant.
 */
export const EXEMPT: Readonly<Record<string, string>> = {}

/**
 * The named leftovers of B-PR-04…09 whose answers name another customer's work without a work order model in their own
 * reads (an item of a private-label style, a scenario's moves, a run's log lines): swept with the walker's routes.
 */
export const ALSO: readonly RegExp[] = [/^\/planning\/strategy\b/, /^\/planning\/schedule\/what-ifs\b/, /^\/planning\/runs\b/, /^\/product\/styles$/, /^\/product\/styles\/:styleId$/]

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface WallSweepOptions {
  /** The tenant and the two customers: A's records are sent, B's limited session reads. */
  readonly ids: { readonly tenantId: string; readonly a: string; readonly b: string }
  /** The test sessions of the app the sweep calls (read when a request is sent: a test may add one later). */
  readonly sessions: Readonly<Record<string, OfficeSession>>
  /** The session limited to brand B (default `office.p2`). */
  readonly reader?: string
  /** The session of every customer, the production unit (default `office.all`). */
  readonly everyone?: string
  /** When set, `report(name, value)` writes `<prefix>.<name>.json` (FACTORY_PR10_SWEEP_REPORT). */
  readonly reportPrefix?: string | undefined
}

export interface WallSweepWorld {
  readonly db: MigratedDatabase
  /** The app built with `routeSpy` first (every route it registers is seen). */
  readonly app: FastifyInstance
  readonly w: ProductionTwoBrands
  /** The folder of `platform/` and `modules/` (src). */
  readonly srcRoot: string
  readonly schemaDir: string
  /** More words of A's that must never reach B (a flow's own texts), beside A's records' markers. */
  readonly markers?: readonly Marker[]
}

export interface WallSweep {
  /** Sees every route as it registers: its method, address, manifest entry and request schemas. Register it FIRST. */
  readonly routeSpy: FastifyPluginAsync
  /** Every route the app registered, with its manifest entry and its request schemas. */
  readonly routes: ReadonlyMap<string, RouteFacts>
  /** Reads the schema, walks the routes, gathers A's records and markers (after the world is made). */
  prepare(world: WallSweepWorld): Promise<void>
  /** The routes the walker lists (after `prepare`). */
  walked(): readonly WalkedRoute[]
  /** The office routes the walker found (and ALSO), less EXEMPT, in the address order. */
  swept(method: 'read' | 'write'): RouteFacts[]
  /** The values of an enum parameter (an export list, a board kind): each is swept on its own. */
  variantsOf(route: RouteFacts): Json[]
  /** One route, called as the reader with A's ids and with fresh ones: what breaks the wall. */
  sweep(route: RouteFacts, variant?: Json): Promise<Finding[]>
  /** What of A's an answer names: its ids, then its words (the threads' scan, whole tokens). */
  scanForA(text: string): string[]
  /** Every call the sweep made, with its verdict. */
  readonly called: Called[]
  /** Failures of requests that name nothing of A's (not the wall's): for the report. */
  readonly failures: Finding[]
  /** The id fields no model was found for, with the routes that name them. */
  unresolved(): Record<string, string[]>
  report(name: string, value: unknown): void
}

const TODAY = '2026-11-17'
const NOW = '2026-11-17T09:00:00.000Z'

export function createWallSweep(options: WallSweepOptions): WallSweep {
  const ids = options.ids
  const reader = options.reader ?? 'office.p2'
  const everyone = options.everyone ?? 'office.all'
  let db: MigratedDatabase | undefined
  let app: FastifyInstance | undefined
  let w: ProductionTwoBrands | undefined
  let models: SchemaModel[] = []
  let walked: WalkedRoute[] = []
  /** What must never reach brand B: A's markers (names, codes, numbers, references) and the mixed work order's number … */
  let aMarkers: Marker[] = []
  /** … and the ids of A's records (the markers' ids and every record of A's gathered below), found by one look-up each. */
  const aMarkerIds = new Map<string, string>()

  const world = (): { db: MigratedDatabase; app: FastifyInstance; w: ProductionTwoBrands } => {
    if (!db || !app || !w) throw new Error('the wall sweep is not prepared: call prepare() after the world is made')
    return { db, app, w }
  }

  function scanForA(text: string): string[] {
    const found = [...new Set(text.match(UUID) ?? [])].map((id) => id.toLowerCase()).filter((id) => aMarkerIds.has(id)).map((id) => `${aMarkerIds.get(id)}: ${id}`)
    return [...found, ...findMarkers(text, aMarkers)]
  }

  /** Every route the app registered, with its manifest entry and its request schemas (seen by an onRoute hook). */
  const ROUTES = new Map<string, RouteFacts>()

  const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await world().db.admin.query(sql, values)).rows as T[]

  // ---- the records of A's, per model -----------------------------------------------------------------------------------------

  /** A record a request can name: A's own (or of the mixed work order: every customer only) or one that names no customer. */
  interface Picked {
    readonly id: string
    readonly owned: boolean
  }
  /** Per model: up to 200 of A's records (A's own, or the mixed work order's) and one that names no customer. */
  const ofA = new Map<string, string[]>()
  const neutral = new Map<string, string>()
  /** Every id of A's the sweep may send; their swap is a fresh id. */
  const aIds = new Set<string>()

  const modelByName = (name: string): SchemaModel | undefined => models.find((model) => model.name === name)
  const has = (model: SchemaModel, column: string): boolean => model.columns.includes(column)

  /** How a model's rows reach their customer: SQL that lists A's (the mixed work order's count as A's: every customer only). */
  function ownershipSql(model: SchemaModel): string | null {
    const t = `"${model.table}"`
    const tenant = has(model, 'tenantId') ? ` AND x."tenantId" = '${ids.tenantId}'` : ''
    const mixed = `(SELECT id FROM "WorkOrder" WHERE id = '${world().w.mixed.workOrderId}')`
    if (model.name === 'WorkOrder') return `SELECT x.id FROM ${t} x WHERE (x."partyId" = '${ids.a}' OR x.id IN ${mixed})${tenant} ORDER BY x.status DESC, x.id`
    if (model.name === 'Party') return `SELECT x.id FROM ${t} x WHERE x.id = '${ids.a}'`
    if (model.name === 'Style') return `SELECT x.id FROM ${t} x WHERE x."brandPartyId" = '${ids.a}'${tenant}`
    if (has(model, 'workOrderId')) return `SELECT x.id FROM ${t} x JOIN "WorkOrder" o ON o.id = x."workOrderId" WHERE (o."partyId" = '${ids.a}' OR o.id IN ${mixed})${tenant}`
    if (has(model, 'workOrderSizeId')) return `SELECT x.id FROM ${t} x JOIN "WorkOrderSize" c ON c.id = x."workOrderSizeId" JOIN "WorkOrder" o ON o.id = c."workOrderId" WHERE (o."partyId" = '${ids.a}' OR o.id IN ${mixed})${tenant}`
    if (has(model, 'partyId')) return `SELECT x.id FROM ${t} x WHERE x."partyId" = '${ids.a}'${tenant}`
    // One step up: a column `<relation>Id` to a model that names its customer.
    for (const field of model.fields) {
      if (!field.relation || field.list || !has(model, `${field.name}Id`)) continue
      const parent = modelByName(field.type)
      if (!parent || parent.name === model.name) continue
      const via = has(parent, 'partyId') ? `p."partyId" = '${ids.a}'` : has(parent, 'workOrderId') ? `p."workOrderId" IN (SELECT id FROM "WorkOrder" WHERE "partyId" = '${ids.a}')` : parent.name === 'WorkOrder' ? `p."partyId" = '${ids.a}'` : null
      if (via) return `SELECT x.id FROM ${t} x JOIN "${parent.table}" p ON p.id = x."${field.name}Id" WHERE ${via}${tenant}`
    }
    return null
  }

  async function gatherRecords(): Promise<void> {
    for (const model of models) {
      if (!model.columns.includes('id')) continue
      const sql = ownershipSql(model)
      const own = sql ? (await admin<{ id: string }>(`${sql} LIMIT 200`)).map((row) => String(row.id)) : []
      if (own.length > 0) {
        ofA.set(model.name, own)
        for (const id of own) aIds.add(id)
      }
      const tenant = has(model, 'tenantId') ? `WHERE "tenantId" = '${ids.tenantId}'` : ''
      const any = await admin<{ id: string }>(`SELECT id FROM "${model.table}" ${tenant} ${sql ? `${tenant ? 'AND' : 'WHERE'} id NOT IN (${sql})` : ''} ORDER BY id LIMIT 1`).catch(() => [])
      if (any[0]) neutral.set(model.name, String(any[0].id))
    }
  }

  /** The model a parameter or a body field names (`workOrderId`, `workOrderIds`, `ncrId` …), from its name and the address. */
  const PARAM_MODELS: Readonly<Record<string, string>> = {
    assignmentId: 'DispatchAssignment',
    callId: 'HelpCall',
    caseId: 'ServiceCase',
    cellId: 'WorkOrderSize',
    checkId: 'InProcessCheck',
    concessionId: 'NcrConcession',
    countId: 'StockCount',
    couponId: 'BundleCoupon',
    discrepancyId: 'ReceiptDiscrepancy',
    disputeId: 'LabourDispute',
    downgradeId: 'GarmentDowngrade',
    estimateId: 'RepairEstimate',
    exceptionId: 'PlanningException',
    findingId: 'ScanPatternFinding',
    heldScanId: 'HeldScan',
    holdId: 'QualityHold',
    kitLineId: 'SubcontractKitLine',
    manifestId: 'DispatchManifest',
    moveId: 'StockMove',
    ncrId: 'Nonconformance',
    orderLineId: 'SalesOrderLine',
    plannedOrderId: 'PlannedWorkOrder',
    processId: 'SecondaryProcess',
    progressId: 'RecallProgress',
    refusalId: 'FloorScanRefusal',
    releaseId: 'QualityRelease',
    repairId: 'RepairOrder',
    replacementId: 'ReplacementRequest',
    returnId: 'ReturnAuthorisation',
    returnNoticeId: 'SubcontractReturnNotice',
    reworkId: 'ReworkOrder',
    rollResultId: 'IncomingRollResult',
    roundId: 'SampleRound',
    scanId: 'OperationScan',
    scenarioId: 'WhatIfScenario',
    serialId: 'GarmentSerial',
    slotId: 'ScheduleSlot',
    substitutionId: 'MaterialSubstitution',
    testId: 'ProductionControlTest',
    ticketId: 'CutTicket',
    transferId: 'TransferOrder',
    triggerId: 'InspectionTrigger',
  }
  /** A parameter whose model depends on the address. */
  const PATH_PARAMS: readonly [RegExp, string, string][] = [
    [/^\/production\/trolleys/, 'issueId', 'CutIssue'],
    [/^\/(?:sales|costing\/margins|invoicing)\/orders/, 'orderId', 'SalesOrder'],
    [/^\/production\/offstandard/, 'blockId', 'OffStandardEntry'],
    [/^\/quality\/capa/, 'actionId', 'CapaAction'],
    [/^\/quality\/capa/, 'sourceId', 'CapaSource'],
  ]

  function modelOf(name: string, url: string): string | null {
    for (const [path, param, model] of PATH_PARAMS) if (param === name && path.test(url)) return model
    const singular = name.replace(/Ids$/, 'Id')
    if (PARAM_MODELS[singular]) return PARAM_MODELS[singular]!
    if (!/Id$/.test(singular)) return null
    const pascal = singular[0]!.toUpperCase() + singular.slice(1, -2)
    return modelByName(pascal) ? pascal : null
  }

  /** The rows of A's a route's own list (or its parent record) shows the production unit: the id an address names. */
  const listed = new Map<string, Picked | null>()
  async function listedId(route: RouteFacts, name: string, params: Json): Promise<Picked | null> {
    const at = route.url.indexOf(`/:${name}`)
    const prefix = route.url.slice(0, at)
    const key = `${prefix}|${name}|${JSON.stringify(params)}`
    if (listed.has(key)) return listed.get(key)!
    listed.set(key, null)
    const segment = prefix.split('/').pop() ?? ''
    const field = segment.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    const sources = [ROUTES.get(`GET ${prefix}`), ROUTES.get(`GET ${prefix.slice(0, prefix.lastIndexOf('/'))}`)].filter((source): source is RouteFacts => source !== undefined && source.method === 'GET')
    for (const source of sources) {
      const request = await requestOf(source, params)
      const answer = await send(everyone, request)
      if (answer.status < 200 || answer.status >= 300 || !answer.json) continue
      // The ids under the address's own word (`lines`, `holds`) first, then any id the answer shows.
      const under = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((row) => (row && typeof row === 'object' && typeof (row as Json).id === 'string' ? [(row as Json).id as string] : [])) : [])
      const own = source.url === prefix ? JSON.stringify(answer.json).match(UUID) ?? [] : under((answer.json as Json)[field] ?? Object.values(answer.json).find((value) => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Json)[field]))?.[field])
      const used = new Set(Object.values(params).map(String))
      const candidates = own.map((id) => id.toLowerCase()).filter((id) => !used.has(id))
      const ofAId = candidates.find((id) => aIds.has(id))
      const pick = ofAId ? { id: ofAId, owned: true } : candidates[0] ? { id: candidates[0], owned: false } : null
      if (pick) {
        listed.set(key, pick)
        return pick
      }
    }
    return null
  }

  const unresolved = new Map<string, Set<string>>()
  /** The value of an id field: one of A's records of its model, else one that names no customer, else a fresh id. */
  function idFor(name: string, url: string): Picked {
    const { w: made } = world()
    if (name === 'siteId') return { id: made.siteId, owned: false }
    if (name === 'companyId') return { id: made.companyId, owned: false }
    if (name === 'tenantId') return { id: made.tenantId, owned: false }
    const model = modelOf(name, url)
    const own = model ? ofA.get(model)?.[0] : undefined
    if (own) return { id: own, owned: true }
    const other = model ? neutral.get(model) : undefined
    if (other) return { id: other, owned: false }
    if (!unresolved.has(name)) unresolved.set(name, new Set())
    unresolved.get(name)!.add(url)
    return { id: newId(), owned: false }
  }

  // ---- requests from the routes' own schemas ---------------------------------------------------------------------------------

  type JsonSchema = {
    type?: string | string[]
    properties?: Record<string, JsonSchema>
    required?: string[]
    items?: JsonSchema
    prefixItems?: JsonSchema[]
    enum?: unknown[]
    const?: unknown
    anyOf?: JsonSchema[]
    oneOf?: JsonSchema[]
    allOf?: JsonSchema[]
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
    exclusiveMinimum?: number
    exclusiveMaximum?: number
    minItems?: number
    maxItems?: number
    format?: string
    pattern?: string
    default?: unknown
    $ref?: string
    $defs?: Record<string, JsonSchema>
    additionalProperties?: boolean | JsonSchema
  }

  function jsonSchemaOf(schema: unknown): JsonSchema | null {
    if (!schema || typeof schema !== 'object') return null
    try {
      return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema
    } catch {
      return null
    }
  }

  /** A string a pattern accepts, for the simple patterns contracts use (classes, counts, groups with alternatives). */
  function fromPattern(pattern: string): string | null {
    let out = ''
    let i = pattern.startsWith('^') ? 1 : 0
    const end = pattern.endsWith('$') ? pattern.length - 1 : pattern.length
    const atom = (): string | null => {
      const c = pattern[i]!
      if (c === '\\') {
        const e = pattern[i + 1]!
        i += 2
        return e === 'd' ? '1' : e === 'w' ? 'a' : e === 's' ? ' ' : e
      }
      if (c === '[') {
        const close = pattern.indexOf(']', i)
        const body = pattern.slice(i + 1, close)
        i = close + 1
        if (body.startsWith('^')) return 'a'
        const first = body.startsWith('\\') ? (body[1] === 'd' ? '1' : body[1] === 'w' ? 'a' : body[1]!) : body[0]!
        return first
      }
      if (c === '(') {
        let level = 0
        let j = i
        for (; j < end; j++) {
          if (pattern[j] === '\\') j++
          else if (pattern[j] === '(') level++
          else if (pattern[j] === ')' && --level === 0) break
        }
        const inner = pattern.slice(pattern.startsWith('(?:', i) ? i + 3 : i + 1, j)
        i = j + 1
        let depth = 0
        let cut = inner.length
        for (let k = 0; k < inner.length; k++) {
          if (inner[k] === '\\') k++
          else if (inner[k] === '(') depth++
          else if (inner[k] === ')') depth--
          else if (inner[k] === '|' && depth === 0) {
            cut = k
            break
          }
        }
        return fromPattern(inner.slice(0, cut))
      }
      if (c === '.') {
        i++
        return 'a'
      }
      i++
      return c
    }
    while (i < end) {
      const piece = atom()
      if (piece === null) return null
      const q = pattern[i]
      if (q === '{') {
        const close = pattern.indexOf('}', i)
        const n = Number(pattern.slice(i + 1, close).split(',')[0])
        i = close + 1
        out += piece.repeat(n)
      } else if (q === '+') {
        i++
        out += piece
      } else if (q === '*' || q === '?') i++
      else out += piece
      if (pattern[i] === '?') i++
    }
    return out
  }

  interface Sampling {
    readonly url: string
    /** Optional fields too (a list's filters), not only the required ones. */
    readonly optionalIds: boolean
  }

  function sample(schema: JsonSchema, name: string, ctx: Sampling, root: JsonSchema): unknown {
    if (schema.$ref) {
      const key = schema.$ref.replace(/^#\/\$defs\//, '')
      const target = root.$defs?.[key]
      return target ? sample(target, name, ctx, root) : null
    }
    if (schema.const !== undefined) return schema.const
    if (schema.enum && schema.enum.length > 0) return schema.enum.find((value) => value !== null) ?? schema.enum[0]
    const choices = schema.anyOf ?? schema.oneOf
    if (choices && choices.length > 0) {
      const chosen = choices.find((option) => option.type !== 'null') ?? choices[0]!
      return sample(chosen, name, ctx, root)
    }
    if (schema.allOf && schema.allOf.length > 0) return sample(Object.assign({}, ...schema.allOf) as JsonSchema, name, ctx, root)
    const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? schema.type[0]) : schema.type
    switch (type) {
      case 'object': {
        const out: Json = {}
        const required = new Set(schema.required ?? [])
        for (const [key, value] of Object.entries(schema.properties ?? {})) {
          const idLike = /Ids?$/.test(key) && key !== 'requestId'
          const wanted = required.has(key) || (ctx.optionalIds && idLike && modelOf(key, ctx.url) !== null && ofA.has(modelOf(key, ctx.url)!))
          if (wanted) out[key] = sample(value, key, ctx, root)
        }
        return out
      }
      case 'array': {
        const count = Math.max(schema.minItems ?? 0, /Ids$|^ids$|^lines$|^rows$|^items$/.test(name) ? 1 : 0)
        const items = schema.prefixItems ?? Array.from({ length: count }, () => schema.items ?? {})
        return items.map((item) => sample(item, name.replace(/Ids$/, 'Id').replace(/^ids$/, 'id'), ctx, root))
      }
      case 'integer':
      case 'number': {
        let value = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : /version/i.test(name) ? 1 : 1)
        if (schema.maximum !== undefined && value > schema.maximum) value = schema.maximum
        return type === 'integer' ? Math.ceil(value) : value
      }
      case 'boolean':
        return false
      case 'null':
        return null
      case 'string':
        return stringFor(schema, name, ctx)
      default:
        return stringFor(schema, name, ctx)
    }
  }

  function stringFor(schema: JsonSchema, name: string, ctx: Sampling): string {
    const fit = (value: string): string => {
      let out = value
      if (schema.minLength !== undefined && out.length < schema.minLength) out = out.padEnd(schema.minLength, 'x')
      if (schema.maxLength !== undefined && out.length > schema.maxLength) out = out.slice(0, schema.maxLength)
      return out
    }
    if (schema.format === 'uuid' || /Id$|^id$/.test(name)) return idFor(name === 'id' ? 'workOrderId' : name, ctx.url).id
    if (schema.format === 'date-time' || /At$/.test(name)) return NOW
    if (schema.format === 'date' || /(?:^|[a-z])(?:Date|Day)$|^(?:date|day|from|to|since|until|workDate|month)$/.test(name)) return name === 'month' ? TODAY.slice(0, 7) : TODAY
    if (schema.format === 'email' || /email/i.test(name)) return 'sweep@example.com'
    if (schema.format === 'uri' || schema.format === 'url' || /url$/i.test(name)) return 'https://example.com/sweep'
    if (/currency/i.test(name)) return 'EUR'
    if (/locale|language/i.test(name)) return 'en'
    if (/country/i.test(name)) return 'IT'
    if (schema.pattern) {
      const made = fromPattern(schema.pattern)
      if (made !== null) return made
    }
    return fit('sweep')
  }

  /** Puts `value` at `path` (`body/lines/0/size`) of the request. */
  function setAt(request: Request, path: string, value: unknown): void {
    const [where, ...rest] = path.split('/')
    const target: Json | undefined = where === 'body' ? (request.body as Json | undefined) : where === 'querystring' ? request.query : where === 'params' ? request.params : undefined
    if (!target || rest.length === 0) return
    let at: any = target
    for (const key of rest.slice(0, -1)) {
      if (at[key] === undefined || at[key] === null || typeof at[key] !== 'object') at[key] = /^\d+$/.test(rest[rest.indexOf(key) + 1] ?? '') ? [] : {}
      at = at[key]
    }
    at[rest[rest.length - 1]!] = value
  }

  /** A guess for a field a validation issue names, from its words. */
  function repairOf(message: string, field: string): unknown {
    if (/YYYY-MM-DD|calendar day/i.test(message)) return TODAY
    if (/ISO 8601|time with a zone/i.test(message)) return NOW
    if (/currency/i.test(message)) return 'EUR'
    if (/expected number/i.test(message)) return 1
    if (/expected boolean/i.test(message)) return false
    if (/expected array/i.test(message)) return []
    if (/expected object/i.test(message)) return {}
    if (/uuid/i.test(message)) return idFor(field, '').id
    const atLeast = message.match(/>=\s*(\d+)\s*characters|at least (\d+) character/i)
    if (atLeast) return 'x'.repeat(Number(atLeast[1] ?? atLeast[2]))
    return undefined
  }

  interface Request {
    readonly route: RouteFacts
    params: Json
    query: Json
    body: unknown
  }

  function addressOf(request: Request): string {
    let url = request.route.url
    for (const [key, value] of Object.entries(request.params)) url = url.replace(`:${key}`, encodeURIComponent(String(value)))
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue
      for (const one of Array.isArray(value) ? value : [value]) query.append(key, typeof one === 'object' ? JSON.stringify(one) : String(one))
    }
    const text = query.toString()
    return text ? `${url}?${text}` : url
  }

  /** The request of a route with A's ids; `variant` picks the n-th value of an enum parameter. */
  async function requestOf(route: RouteFacts, variant: Json = {}): Promise<Request> {
    const ctx: Sampling = { url: route.url, optionalIds: true }
    const params: Json = {}
    const paramsSchema = jsonSchemaOf(route.params)
    for (const name of [...route.url.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!)) {
      const own = paramsSchema?.properties?.[name]
      const isId = own ? own.format === 'uuid' || /Id$/.test(name) : /Id$/.test(name)
      if (variant[name] !== undefined) params[name] = variant[name]
      else if (name === 'recordType') params[name] = 'WorkOrder'
      else if (name === 'recordId') params[name] = idFor('workOrderId', route.url).id
      else if (!isId) params[name] = own && paramsSchema ? sample(own, name, ctx, paramsSchema) : 'sweep'
      else {
        const model = modelOf(name, route.url)
        const ownId = model ? ofA.get(model)?.[0] : undefined
        params[name] = ownId ?? (await listedId(route, name, params))?.id ?? idFor(name, route.url).id
      }
    }
    const querySchema = jsonSchemaOf(route.querystring)
    const query = querySchema ? ((sample(querySchema, 'query', ctx, querySchema) as Json) ?? {}) : {}
    const bodySchema = route.method === 'GET' ? null : jsonSchemaOf(route.body)
    const body = bodySchema ? sample(bodySchema, 'body', { url: route.url, optionalIds: false }, bodySchema) : route.method === 'GET' ? undefined : {}
    return { route, params, query, body }
  }

  /** The same request with a fresh id in place of each of A's (one fresh id per id of A's). */
  function swapped(request: Request): { request: Request; map: Map<string, string> } {
    const map = new Map<string, string>()
    const swap = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => (aIds.has(id) ? (map.get(id) ?? (map.set(id, newId()), map.get(id)!)) : id)))
    return { request: { route: request.route, params: swap(request.params) as Json, query: swap(request.query) as Json, body: request.body === undefined ? undefined : swap(request.body) }, map }
  }

  /** The ids of A's a request names. */
  function namedIds(request: Request): string[] {
    const text = JSON.stringify([request.params, request.query, request.body ?? null])
    return [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])].filter((id) => aIds.has(id))
  }

  interface Answer {
    readonly status: number
    readonly json: Json | null
    readonly raw: string
    readonly type: string
  }

  async function send(session: string, request: Request): Promise<Answer> {
    const method = request.route.method
    const url = addressOf(request)
    const inject = world().app.inject({
      method,
      url,
      headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) },
      ...(request.body === undefined ? {} : { payload: request.body as object }),
    })
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000))
    const response = await Promise.race([inject, timeout])
    if (!response) return { status: 0, json: null, raw: 'TIMEOUT', type: '' }
    if (response.statusCode >= 500) {
      const requestId = (() => {
        try {
          return String((response.json() as Json).error?.requestId ?? '')
        } catch {
          return ''
        }
      })()
      return { status: response.statusCode, json: null, raw: `${response.body.slice(0, 120)} CAUSE ${errors.get(requestId) ?? '?'}`, type: '' }
    }
    const type = String(response.headers['content-type'] ?? '')
    let json: Json | null = null
    if (type.startsWith('application/json')) {
      try {
        json = response.json() as Json
      } catch {
        json = null
      }
    }
    return { status: response.statusCode, json, raw: type.startsWith('application/pdf') || type.startsWith('image/') || type.startsWith('application/zip') || type.includes('spreadsheet') ? '' : response.body, type }
  }

  /** Sends a request, mending the fields a validation refusal names (dates, codes, sizes) up to four times. */
  async function sendMended(session: string, request: Request): Promise<Answer> {
    let answer = await send(session, request)
    for (let round = 0; round < 4 && answer.status === 400 && answer.json?.error?.code === 'validation_failed'; round++) {
      const issues = (answer.json.error.issues ?? []) as { path: string; message: string }[]
      let mended = false
      for (const issue of issues) {
        const field = issue.path.split('/').filter((part) => !/^\d+$/.test(part)).pop() ?? ''
        const value = repairOf(issue.message, field)
        if (value !== undefined) {
          setAt(request, issue.path, value)
          mended = true
        }
      }
      if (!mended) break
      answer = await send(session, request)
    }
    return answer
  }

  /** An answer's words for the comparison: the request id, timings and the asked ids written alike. */
  function wordsOf(answer: Answer, map: ReadonlyMap<string, string>, asked: 'a' | 'fresh'): string {
    let text = answer.json ? JSON.stringify(answer.json) : answer.raw
    let n = 0
    for (const [a, fresh] of map) {
      text = text.replaceAll(asked === 'a' ? a : fresh, `<asked:${n}>`)
      n++
    }
    return text.replace(/"requestId":"[^"]*"/g, '"requestId":"<request>"').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
  }

  const everyPartyRefusal = (answer: Answer): boolean => answer.status === 403 && JSON.stringify(answer.json ?? '').includes(EVERY_PARTY_WORDS.en.slice(0, 30))

  async function auditRowsOf(actorId: string): Promise<{ count: number; ofA: number }> {
    const rows = await admin<{ count: string; of_a: string }>(
      `SELECT count(*) AS count, count(*) FILTER (WHERE "partyId" = $2 OR "recordId" = ANY($3::uuid[])) AS of_a FROM "AuditLog" WHERE "actorId" = $1`,
      [actorId, ids.a, [...aIds]],
    )
    return { count: Number(rows[0]!.count), ofA: Number(rows[0]!.of_a) }
  }

  // ---- the sweep -------------------------------------------------------------------------------------------------------------

  const called: Called[] = []
  const failures: Finding[] = []

  async function sweep(route: RouteFacts, variant: Json = {}): Promise<Finding[]> {
    const key = `${route.method} ${route.url}`
    const findings: Finding[] = []
    const request = await requestOf(route, variant)
    const session = options.sessions[reader]
    if (!session) throw new Error(`the wall sweep has no session ${reader}`)
    const p2 = session.actorId
    const before = route.method === 'GET' ? null : await auditRowsOf(p2)
    const a = await sendMended(reader, request)
    const after = route.method === 'GET' ? null : await auditRowsOf(p2)
    const named = namedIds(request)
    const url = addressOf(request)
    const { request: other, map } = swapped(request)
    const fresh = named.length > 0 ? await send(reader, other) : null
    const all = route.method === 'GET' ? await send(everyone, request) : null
    // 1. No answer names anything of A's (the ids the reader sent itself aside).
    let scanned = a.json ? JSON.stringify(a.json) : a.raw
    for (const id of named) scanned = scanned.replaceAll(id, '<asked>')
    const leaks = scanForA(scanned)
    if (leaks.length > 0) findings.push({ route: key, url, what: `names A's ${leaks.slice(0, 4).join(', ')}` })
    // A failure on a request that names A's records may hide a way past the wall: a finding. One that names none (an outside
    // call this test has no gateway for, a module's own error on made-up input) is kept for the report, not the wall.
    // A request this process cannot serve (an outside service it has no environment or gateway for) fails before any record is
    // read: A's ids and an unknown id fail alike (checked below), so it tells nothing; kept for the report, as one naming none.
    const outside = (answer: Answer | null): boolean => answer !== null && answer.status >= 500 && /FactoryEnvError|the sweep has no gateway/.test(answer.raw)
    const failed = a.status >= 500 || a.status === 0
    const infra = failed && outside(a) && (named.length === 0 || outside(fresh))
    if (failed && !infra && named.length > 0) findings.push({ route: key, url, what: `answers ${a.status || 'nothing (20 s)'}: ${a.raw.slice(0, 200)}` })
    if (failed && (infra || named.length === 0)) failures.push({ route: key, url, what: a.raw.slice(0, 300) })
    // 2. A's record answers as an unknown one (or the view needs every customer).
    if (fresh && !everyPartyRefusal(a)) {
      const ok2xx = a.status >= 200 && a.status < 300
      const fresh2xx = fresh.status >= 200 && fresh.status < 300
      if (a.status >= 500 && fresh.status >= 500) {
        // Both failed: reported above.
      } else if (a.status !== fresh.status) findings.push({ route: key, url, what: `A's ids answer ${a.status}, an unknown id ${fresh.status}: ${a.raw.slice(0, 160)}` })
      else if (!ok2xx && wordsOf(a, map, 'a') !== wordsOf(fresh, map, 'fresh')) findings.push({ route: key, url, what: `A's ids are refused in other words than an unknown id: ${wordsOf(a, map, 'a').slice(0, 160)} ≠ ${wordsOf(fresh, map, 'fresh').slice(0, 160)}` })
      if (route.method !== 'GET' && ok2xx && !fresh2xx) findings.push({ route: key, url, what: `a write with A's ids succeeded (${a.status})` })
    }
    // 3. A write with A's ids writes nothing about A.
    if (before && after && after.ofA > before.ofA) findings.push({ route: key, url, what: `a write with A's ids wrote ${after.ofA - before.ofA} audit row(s) about A` })
    called.push({ route: key, url, a: a.status, fresh: fresh?.status ?? null, all: all?.status ?? null, named: named.length, verdict: findings.map((finding) => finding.what).join(' | ') || 'ok' })
    return findings
  }

  function variantsOf(route: RouteFacts): Json[] {
    const schema = jsonSchemaOf(route.params)
    const out: Json[] = [{}]
    for (const [name, property] of Object.entries(schema?.properties ?? {})) {
      const values = property.enum ?? property.anyOf?.flatMap((option) => option.enum ?? (option.const !== undefined ? [option.const] : []))
      if (values && values.length > 1) return values.slice(0, 80).map((value) => ({ [name]: value }))
    }
    return out
  }

  function swept(method: 'read' | 'write'): RouteFacts[] {
    const keys = new Set([...walked.map((route) => route.key), ...[...ROUTES.keys()].filter((key) => ALSO.some((also) => also.test(key.split(' ')[1]!)))])
    return [...keys]
      .map((key) => ROUTES.get(key))
      .filter((route): route is RouteFacts => route !== undefined)
      .filter((route) => route.manifest.audiences !== 'public' && (route.manifest.audiences as readonly string[]).includes('office'))
      .filter((route) => !EXEMPT[`${route.method} ${route.url}`])
      .filter((route) => (method === 'read' ? route.method === 'GET' : route.method !== 'GET'))
      .sort((x, y) => `${x.url} ${x.method}`.localeCompare(`${y.url} ${y.method}`))
  }

  // ---- the spy -----------------------------------------------------------------------------------------------------------------

  /** The last unexpected error of a request (a 500's cause, for the report). */
  const errors = new Map<string, string>()
  const routeSpy: FastifyPluginAsync = async (instance) => {
    instance.addHook('onError', async (request, _reply, error) => {
      errors.set(String(request.id), `${error.name}: ${error.message}`.slice(0, 300))
    })
    instance.addHook('onRoute', (route: RouteOptions) => {
      const schema = (route.schema ?? {}) as { params?: unknown; querystring?: unknown; body?: unknown }
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        ROUTES.set(`${String(method).toUpperCase()} ${route.url}`, { method: String(method).toUpperCase() as Method, url: route.url ?? '', manifest: (route.config as { manifest?: RouteManifestEntry } | undefined)?.manifest ?? { audiences: 'public', permission: 'public', scope: 'none' }, params: schema.params, querystring: schema.querystring, body: schema.body })
      }
    })
  }
  // The hook must see the routes of the files registered after it: not encapsulated (as fastify-plugin does).
  Object.defineProperty(routeSpy, Symbol.for('skip-override'), { value: true })

  return {
    routeSpy,
    routes: ROUTES,
    async prepare(input) {
      db = input.db
      app = input.app
      w = input.w
      models = readSchemaFolder(input.schemaDir)
      walked = walkWorkOrderRoutes({ srcRoot: input.srcRoot, schemaDir: input.schemaDir })
      await gatherRecords()
      const all = [...(await markersOf(input.db, ids.a)), { label: 'mixed work order', text: input.w.mixed.number }, { label: 'mixed work order', text: input.w.mixed.workOrderId }, ...(input.markers ?? [])]
      for (const marker of all) if (/^[0-9a-f-]{36}$/i.test(marker.text)) aMarkerIds.set(marker.text.toLowerCase(), marker.label)
      for (const id of aIds) if (!aMarkerIds.has(id)) aMarkerIds.set(id, 'record of A')
      aMarkers = all.filter((marker) => !/^[0-9a-f-]{36}$/i.test(marker.text))
    },
    walked: () => walked,
    swept,
    variantsOf,
    sweep,
    scanForA,
    called,
    failures,
    unresolved: () => Object.fromEntries([...unresolved].map(([name, urls]) => [name, [...urls]])),
    report(name, value) {
      if (options.reportPrefix) writeFileSync(`${options.reportPrefix}.${name}.json`, JSON.stringify(value, null, 1))
    },
  }
}

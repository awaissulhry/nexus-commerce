import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
// The factory-db schema reader is no package export: a test reads it where it lives.
import { readSchemaFolder, type SchemaModel } from '../../../../../packages/factory-db/src/schema-models'
import { localFileStore } from '../../adapters/local-files/local'
import { routesFiles } from '../../core/autoload'
import { buildApp } from '../../core/app'
import { testAuthenticator } from '../../core/context'
import type { RouteManifestEntry } from '../../core/manifest'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../env'
import { createOfficeAuth } from '../../platform/auth/sessions/office-auth'
import { createEmailRuntime, useEmail } from '../../platform/email-out/service'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import type { Gateway } from '../../platform/gateway/gateway'
import { useGateway } from '../../platform/gateway/service'
import { findMarkers, markersOf, OWN_STYLE_CODE, productionTwoBrands, twoBrandIds, twoBrandSessions, walkWorkOrderRoutes, workOrderModels, type Marker, type OfficeSession, type ProductionTwoBrands, type WalkedRoute } from './testing/two-brands'

/**
 * B-PR-10 — THE BRAND-WALL SWEEP (production plan §2 "Proof": "a sweep of every route, reads AND writes, that touches work
 * orders"; Appendix D PW-10 "writes with another brand's ids (bulk edit, Hold N, Release N, Travellers N, cut order)"). Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."
 *
 * 1. The manifest walker (./testing/two-brands.ts walkWorkOrderRoutes) lists EVERY route of any method whose handler reads
 *    WorkOrder, WorkOrderSize or a model that names one of them — from the schema, the routes files and the code, never a hand
 *    list. The office routes among them are swept; EXEMPT names each one left out and why.
 * 2. Each swept route is called as `office.p2` — every office permission, limited to brand B — with brand A's ids in its address,
 *    its query and its body (A = the seeds' customer P1: every seed file runs, so A owns work orders in every state with their
 *    bundles, scans, cuts, inspections, holds, NCRs, CAPAs, shipments, returns, repairs, subcontract orders …), and again with
 *    a fresh id in place of each of A's (an unknown record):
 *      - A's answer is word for word the unknown one's (status and words; the request id and the asked ids aside), or a
 *        403 in EVERY_PARTY words: another customer's record is not found, a view that mixes customers needs every customer;
 *      - a write with A's ids is refused (never 2xx while the unknown one is refused) and writes no audit row about A;
 *      - no answer names anything of A (the threads' marker scan: names, codes, numbers, references, ids — the ids p2 itself
 *        sent are left out) — also on a route whose request names nothing of A (a list, a board, a report).
 *    The production unit (`office.all`, the same permissions, every customer) reads the same GET addresses: how many it reaches
 *    is printed (the sweep proves the wall on real records, not on ids that exist nowhere).
 * 3. The named leftovers of B-PR-04…09 (CAPA, the styles list, the subcontract orders' own list, the MPS screen, planning
 *    allocation, what-ifs, day sheets, the run log, the warehouse exports) have their own tests below, with each decision.
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), every
 * seed file in name order (as `npm run seed`), the production two-brand harness (A's and B's draft work orders through the real
 * route, a mixed one made before the rule). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-wall`.
 */

const ns = 'pr10-brand-wall'
const ids = twoBrandIds(ns)
const SRC = fileURLToPath(new URL('../..', import.meta.url))
const SCHEMA_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/prisma/schema', import.meta.url))
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
/** Every permission an office role can hold, money grains included (the sweep reads every field there is). */
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name)
const SESSIONS: Record<string, OfficeSession> = twoBrandSessions(ids.tenantId, ids.a, ids.b, OFFICE_PERMISSIONS)
const REPORT = process.env.FACTORY_PR10_SWEEP_REPORT

/**
 * Routes the walker lists that the sweep does not call, each with its reason. Office routes only are swept: a floor device
 * reaches every customer of its site by design (plan §2: floor screens show the customer code), partner and link sessions are
 * fixed to their own party by the session (row-level security), the platform has no tenant.
 */
const EXEMPT: Readonly<Record<string, string>> = {}

/**
 * The named leftovers of B-PR-04…09 whose answers name another customer's work without a work order model in their own
 * reads (an item of a private-label style, a scenario's moves, a run's log lines): swept with the walker's routes.
 */
const ALSO: readonly RegExp[] = [/^\/planning\/strategy\b/, /^\/planning\/schedule\/what-ifs\b/, /^\/planning\/runs\b/, /^\/product\/styles$/, /^\/product\/styles\/:styleId$/]

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let models: SchemaModel[]
let walked: WalkedRoute[]
let filesRoot: string | undefined
/** What must never reach brand B: A's markers (names, codes, numbers, references) and the mixed work order's number … */
let aMarkers: Marker[]
/** … and the ids of A's records (the markers' ids and every record of A's gathered below), found by one look-up each. */
const aMarkerIds = new Map<string, string>()
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** What of A's an answer names: its ids, then its words (the threads' scan, whole tokens). */
function scanForA(text: string): string[] {
  const ids = [...new Set(text.match(UUID) ?? [])].map((id) => id.toLowerCase()).filter((id) => aMarkerIds.has(id)).map((id) => `${aMarkerIds.get(id)}: ${id}`)
  return [...ids, ...findMarkers(text, aMarkers)]
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface RouteFacts {
  readonly method: Method
  readonly url: string
  readonly manifest: RouteManifestEntry
  readonly params?: unknown
  readonly querystring?: unknown
  readonly body?: unknown
}
/** Every route the app registered, with its manifest entry and its request schemas (seen by an onRoute hook). */
const ROUTES = new Map<string, RouteFacts>()

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

// ---- the records of A's, per model -------------------------------------------------------------------------------------------

/** A record a request can name: A's own (or of the mixed work order: every customer only) or one that names no customer. */
interface Pick {
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
  const mixed = `(SELECT id FROM "WorkOrder" WHERE id = '${w.mixed.workOrderId}')`
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
const listed = new Map<string, Pick | null>()
async function listedId(route: RouteFacts, name: string, params: Json): Promise<Pick | null> {
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
    const answer = await send('office.all', request)
    if (answer.status < 200 || answer.status >= 300 || !answer.json) continue
    // The ids under the address's own word (`lines`, `holds`) first, then any id the answer shows.
    const under = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((row) => (row && typeof row === 'object' && typeof (row as Json).id === 'string' ? [(row as Json).id as string] : [])) : [])
    const own = source.url === prefix ? JSON.stringify(answer.json).match(UUID) ?? [] : under((answer.json as Json)[field] ?? Object.values(answer.json).find((value) => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Json)[field]))?.[field])
    const used = new Set(Object.values(params).map(String))
    const candidates = own.map((id) => id.toLowerCase()).filter((id) => !used.has(id))
    const ofA = candidates.find((id) => aIds.has(id))
    const pick = ofA ? { id: ofA, owned: true } : candidates[0] ? { id: candidates[0], owned: false } : null
    if (pick) {
      listed.set(key, pick)
      return pick
    }
  }
  return null
}

const unresolved = new Map<string, Set<string>>()
/** The value of an id field: one of A's records of its model, else one that names no customer, else a fresh id. */
function idFor(name: string, url: string): Pick {
  if (name === 'siteId') return { id: w.siteId, owned: false }
  if (name === 'companyId') return { id: w.companyId, owned: false }
  if (name === 'tenantId') return { id: w.tenantId, owned: false }
  const model = modelOf(name, url)
  const own = model ? ofA.get(model)?.[0] : undefined
  if (own) return { id: own, owned: true }
  const other = model ? neutral.get(model) : undefined
  if (other) return { id: other, owned: false }
  if (!unresolved.has(name)) unresolved.set(name, new Set())
  unresolved.get(name)!.add(url)
  return { id: newId(), owned: false }
}

// ---- requests from the routes' own schemas -----------------------------------------------------------------------------------

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

const TODAY = '2026-11-17'
const NOW = '2026-11-17T09:00:00.000Z'

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
  const options = schema.anyOf ?? schema.oneOf
  if (options && options.length > 0) {
    const chosen = options.find((option) => option.type !== 'null') ?? options[0]!
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
      const own = model ? ofA.get(model)?.[0] : undefined
      params[name] = own ?? (await listedId(route, name, params))?.id ?? idFor(name, route.url).id
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
  const inject = app.inject({
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

// ---- the sweep ---------------------------------------------------------------------------------------------------------------

interface Finding {
  readonly route: string
  readonly url: string
  readonly what: string
}
interface Called {
  readonly route: string
  readonly url: string
  readonly a: number
  readonly fresh: number | null
  readonly all: number | null
  readonly named: number
  readonly verdict: string
}
const called: Called[] = []
/** Failures of requests that name nothing of A's (not the wall's): for the report. */
const failures: Finding[] = []

async function sweep(route: RouteFacts, variant: Json = {}): Promise<Finding[]> {
  const key = `${route.method} ${route.url}`
  const findings: Finding[] = []
  const request = await requestOf(route, variant)
  const p2 = SESSIONS['office.p2']!.actorId
  const before = route.method === 'GET' ? null : await auditRowsOf(p2)
  const a = await sendMended('office.p2', request)
  const after = route.method === 'GET' ? null : await auditRowsOf(p2)
  const named = namedIds(request)
  const url = addressOf(request)
  const { request: other, map } = swapped(request)
  const fresh = named.length > 0 ? await send('office.p2', other) : null
  const all = route.method === 'GET' ? await send('office.all', request) : null
  // 1. No answer names anything of A's (the ids p2 sent itself aside).
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

/** The values of an enum parameter (an export list, a board kind): each is swept on its own. */
function variantsOf(route: RouteFacts): Json[] {
  const schema = jsonSchemaOf(route.params)
  const out: Json[] = [{}]
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const values = property.enum ?? property.anyOf?.flatMap((option) => option.enum ?? (option.const !== undefined ? [option.const] : []))
    if (values && values.length > 1) return values.slice(0, 80).map((value) => ({ [name]: value }))
  }
  return out
}

/** The office routes the walker found, less EXEMPT, in the address order. */
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

function report(name: string, value: unknown): void {
  if (REPORT) writeFileSync(`${REPORT}.${name}.json`, JSON.stringify(value, null, 1))
}

// ---- set-up ------------------------------------------------------------------------------------------------------------------

/** The last unexpected error of a request (a 500's cause, for the report). */
const errors = new Map<string, string>()
/** Sees every route as it registers: its method, address, manifest entry and request schemas. */
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

beforeAll(async () => {
  db = await migratedDatabase('pr10_brand_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  // Every seed file in name order, as `npm run seed` (factory-db cli.ts): A (P1) owns records of every kind.
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: ns })
  }
  // Files on the local store (the wall answers before any byte is read); its gateway is never reached by a refusal.
  filesRoot = mkdtempSync(join(tmpdir(), 'factory-pr10-sweep-'))
  const noGateway = new Proxy({}, { get: () => () => { throw new Error('the sweep has no gateway') } }) as Gateway
  const files = createFilesRuntime({ gateway: noGateway, local: localFileStore({ root: filesRoot, environment: 'test' }) })
  useFiles(files)
  // The process's gateway and mail: a refusal answers before either is reached; a call that reaches them is an outside call.
  useGateway(noGateway)
  useEmail(createEmailRuntime({ gateway: noGateway, fake: null, webOrigin: 'http://localhost:3901', files: files.storage }))
  const officeAuth = createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: 'http://localhost:3901', mailer: { deliver: async () => {} } })
  const plugins: FastifyPluginAsync[] = [routeSpy]
  for (const file of routesFiles(SRC)) plugins.push(((await import(pathToFileURL(file).href)) as { default: FastifyPluginAsync }).default)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 1_000_000, perAddressMax: 1_000_000, timeWindowMs: 60_000 } },
    { database, officeAuth, routes: plugins, authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  models = readSchemaFolder(SCHEMA_DIR)
  walked = walkWorkOrderRoutes({ srcRoot: SRC, schemaDir: SCHEMA_DIR })
  await gatherRecords()
  const all = [...(await markersOf(db, ids.a)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
  for (const marker of all) if (/^[0-9a-f-]{36}$/i.test(marker.text)) aMarkerIds.set(marker.text.toLowerCase(), marker.label)
  for (const id of aIds) if (!aMarkerIds.has(id)) aMarkerIds.set(id, 'record of A')
  aMarkers = all.filter((marker) => !/^[0-9a-f-]{36}$/i.test(marker.text))
}, 900_000)

afterAll(async () => {
  useFiles(undefined)
  useGateway(undefined)
  useEmail(undefined)
  if (filesRoot) rmSync(filesRoot, { recursive: true, force: true })
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-PR-10 the brand-wall sweep', () => {
  it('the walker lists every route that reads a work order, from the manifests and the code', () => {
    const keys = new Set(walked.map((route) => route.key))
    // Every route it lists is a registered route with a manifest entry; every registered route was looked at.
    for (const route of walked) expect(ROUTES.has(route.key), route.key).toBe(true)
    const everyRoute = walkWorkOrderRoutes({ srcRoot: SRC, schemaDir: SCHEMA_DIR, all: true })
    for (const key of ROUTES.keys()) if (!['GET /health', 'GET /ready'].includes(key) && !key.includes('/local-files')) expect(everyRoute.some((route) => route.key === key), key).toBe(true)
    // The models: WorkOrder, WorkOrderSize and their children.
    const names = workOrderModels(SCHEMA_DIR).map((model) => model.name)
    for (const name of ['WorkOrder', 'WorkOrderSize', 'Bundle', 'OperationScan', 'CutLog', 'Inspection', 'ShipmentLine', 'ScheduleSlot', 'SubcontractOrder']) expect(names).toContain(name)
    // Routes it must find, whatever the code's layout.
    for (const key of ['GET /production/work-orders/:workOrderId', 'GET /production/work-orders/travellers', 'POST /views/bulk/apply', 'POST /quality/holds', 'POST /production/cut-orders', 'GET /quality/capa', 'GET /purchasing/subcontracting/orders', 'GET /planning/allocation', 'GET /planning/schedule/day-sheets']) expect(keys.has(key), key).toBe(true)
    report('walked', walked.map((route) => ({ key: route.key, file: route.file, via: route.via, audiences: ROUTES.get(route.key)?.manifest.audiences ?? null })))
  })

  it('every GET that reads a work order, called by brand B with brand A ids: as unknown, empty or 403 EVERY_PARTY, never a word of A', async () => {
    const findings: Finding[] = []
    for (const route of swept('read')) for (const variant of variantsOf(route)) findings.push(...(await sweep(route, variant)))
    report('reads', { findings, failures, called: called.filter((call) => call.route.startsWith('GET ')), unresolved: Object.fromEntries([...unresolved].map(([name, urls]) => [name, [...urls]])) })
    const reached = called.filter((call) => call.route.startsWith('GET ') && call.named > 0 && call.all !== null && call.all >= 200 && call.all < 300).length
    console.log(`B-PR-10 GET sweep: ${called.filter((call) => call.route.startsWith('GET ')).length} calls; ${reached} named A's records the production unit reads`)
    expect(findings).toEqual([])
  }, 1_800_000)

  it('PW-10: every write that reads a work order, called by brand B with brand A ids, is refused as unknown and writes no row about A', async () => {
    const findings: Finding[] = []
    for (const route of swept('write')) findings.push(...(await sweep(route)))
    report('writes', { findings, failures, called: called.filter((call) => !call.route.startsWith('GET ')), unresolved: Object.fromEntries([...unresolved].map(([name, urls]) => [name, [...urls]])) })
    expect(findings).toEqual([])
  }, 1_800_000)

  // ---- the named leftovers of B-PR-04…09, each with its decision ----------------------------------------------------------------

  /** One call as a session, its status and body (the sweep's answers are not needed here). */
  const as = async (session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json }> => {
    const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
    let body: Json = {}
    try {
      body = response.json() as Json
    } catch {
      body = {}
    }
    return { status: response.statusCode, body }
  }
  const everyCustomerOnly = async (url: string, method: Method = 'GET', payload?: unknown, everyCustomerReads = method === 'GET'): Promise<void> => {
    const limited = await as('office.p2', method, url, payload)
    expect([limited.status, limited.body.error?.message], `${method} ${url}`).toEqual([403, EVERY_PARTY_WORDS.en])
    if (everyCustomerReads) expect((await as('office.all', method, url, payload)).status, `${method} ${url} (every customer)`).toBe(200)
  }
  const idsIn = (body: unknown): Set<string> => new Set(JSON.stringify(body).match(UUID) ?? [])

  it('CAPA: a CAPA of another customer, or one answering another customer’s NCR, is neither listed nor found', async () => {
    const hidden = await admin<{ id: string }>(
      `SELECT c.id FROM "Capa" c WHERE c."customerId" = $1
       UNION SELECT s."capaId" FROM "CapaSource" s JOIN "Nonconformance" n ON n.id = s."recordId" JOIN "WorkOrder" o ON o.id = n."workOrderId" WHERE s."recordType" = 'Nonconformance' AND o."partyId" = $1`,
      [ids.a],
    )
    expect(hidden.length, 'the seeds hold a CAPA of A’s').toBeGreaterThan(0)
    const listed = idsIn((await as('office.p2', 'GET', '/quality/capa?view=all')).body)
    const all = idsIn((await as('office.all', 'GET', '/quality/capa?view=all')).body)
    for (const { id } of hidden) {
      expect(listed.has(id), `CAPA ${id} listed to brand B`).toBe(false)
      expect(all.has(id), `CAPA ${id} listed to the production unit`).toBe(true)
      expect((await as('office.p2', 'GET', `/quality/capa/${id}`)).status).toBe(404)
      expect((await as('office.all', 'GET', `/quality/capa/${id}`)).status).toBe(200)
    }
  })

  it('the styles list: another customer’s private-label styles are neither listed nor found; our own collection stays everyone’s', async () => {
    const privateOfA = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Style" WHERE "brandPartyId" = $1 AND "tenantId" = $2`, [ids.a, ids.tenantId])
    expect(privateOfA.length).toBeGreaterThan(0)
    const ofB = (await as('office.p2', 'GET', `/product/styles?status=ALL&brandPartyId=${ids.a}`)).body
    const ofAll = (await as('office.all', 'GET', `/product/styles?status=ALL&brandPartyId=${ids.a}`)).body
    expect((ofB.styles as unknown[]).length).toBe(0)
    for (const style of privateOfA) {
      expect(idsIn(ofB).has(style.id), style.code).toBe(false)
      expect(idsIn(ofAll).has(style.id), style.code).toBe(true)
      expect((await as('office.p2', 'GET', `/product/styles/${style.id}`)).status).toBe(404)
    }
    expect(idsIn((await as('office.p2', 'GET', `/product/styles?status=ALL&q=${OWN_STYLE_CODE}`)).body).has(w.styleId), 'our own collection').toBe(true)
  })

  it('the subcontract orders’ own list: an order for another customer’s work order is hidden even from a person who reaches its workshop', async () => {
    const orders = await admin<{ id: string; partyId: string }>(`SELECT s.id, s."partyId" FROM "SubcontractOrder" s JOIN "WorkOrder" o ON o.id = s."workOrderId" WHERE o."partyId" = $1`, [ids.a])
    expect(orders.length).toBeGreaterThan(0)
    // A person limited to brand B AND the workshops: the workshop dimension alone let A's orders through.
    SESSIONS['office.p2w'] = { ...SESSIONS['office.p2']!, grants: [{ permissions: OFFICE_PERMISSIONS, companies: 'all', sites: 'all', parties: [ids.b, ...new Set(orders.map((order) => order.partyId))] }] }
    const listed = idsIn((await as('office.p2w', 'GET', '/purchasing/subcontracting/orders?open=false&limit=200')).body)
    for (const order of orders) {
      expect(listed.has(order.id)).toBe(false)
      expect((await as('office.p2w', 'GET', `/purchasing/subcontracting/orders/${order.id}`)).status).toBe(404)
      expect((await as('office.all', 'GET', `/purchasing/subcontracting/orders/${order.id}`)).status).toBe(200)
    }
  })

  it('the MPS screen, planning allocation, what-ifs, day sheets and the run log need every customer; the change list shows only reached work orders', async () => {
    await everyCustomerOnly(`/planning/strategy?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/allocation?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/allocation/workshops?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/schedule/what-ifs?siteId=${w.siteId}`)
    await everyCustomerOnly(`/planning/schedule/day-sheets/paper?siteId=${w.siteId}`, 'GET', undefined, false)
    const run = (await admin<{ id: string }>(`SELECT id FROM "PlanningRun" WHERE "siteId" = $1 ORDER BY "startedAt" DESC LIMIT 1`, [w.siteId]))[0]
    if (run) await everyCustomerOnly(`/planning/runs/${run.id}/log`)
    const changes = (await as('office.p2', 'GET', `/planning/schedule/changes?siteId=${w.siteId}`)).body
    expect(scanForA(JSON.stringify(changes))).toEqual([])
  })

  it('the warehouse is one stock for every customer: its ledger, stock and their exports need every customer; a work order’s own kit stays its customer’s', async () => {
    await everyCustomerOnly(`/inventory/ledger?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/stock?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/reservations?siteId=${w.siteId}`)
    await everyCustomerOnly(`/inventory/remnants?siteId=${w.siteId}`)
    const body = (listKey: string) => ({ listKey, format: 'CSV', query: `site=${w.siteId}`, columns: [{ key: 'when', label: 'When' }], title: 'Warehouse', locale: 'en' })
    for (const listKey of ['warehouse.moves', 'warehouse.stock', 'warehouse.lots', 'warehouse.hides', 'warehouse.locations']) {
      const refused = await as('office.p2', 'POST', '/exports', body(listKey))
      expect([refused.status, refused.body.error?.message], listKey).toEqual([403, EVERY_PARTY_WORDS.en])
    }
    // B's own work order (the seeds' SEED-WO-B001, brand two's): its kit and pick list stay B's to work.
    const own = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.b]))[0]
    if (own) expect((await as('office.p2', 'GET', `/inventory/kits/${own.id}`)).status).toBe(200)
    const ofA = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'IN_PROGRESS' LIMIT 1`, [ids.a]))[0]!
    expect((await as('office.p2', 'GET', `/inventory/kits/${ofA.id}`)).status).toBe(404)
  })
})


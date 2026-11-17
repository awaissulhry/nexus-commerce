import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { FactoryDatabase } from '@nexus/factory-db'
import type { MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db fixtures and seeds are no package export: a test reads them where they live.
import { readSchemaFolder } from '../../../../../../packages/factory-db/src/schema-models'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import { routesFiles } from '../../../core/autoload'
import type { SessionContext } from '../../../core/context'
import { findMarkers, recordMarkers, type Marker } from '../../../golden-flow/portal/testing/two-brands'
import type { World } from '../../../golden-flow/testing/world'

/**
 * B-PR-03 (production plan §2 "Proof", 08-backend §1.5; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): TWO
 * CUSTOMERS IN PRODUCTION, for every production wall test (PW-xx). It IMPORTS the threads plan's two-brand fixtures and adds only
 * production rows:
 *
 *   - brand A = the seeds' customer P1 ("the one whose data must never show"); brand B = the threads' second brand of the same
 *     tenant (factory-db src/testing/second-brand.ts, B-TH-001: party SEED-C2B and its order SEED-SO-B001), the reader;
 *   - a style of our own collection (a copy of the production seed's SEED-JKT-02 with no brand: the seed's styles are P1's
 *     private label, which another customer never orders), its BLK colourway and released revision 1;
 *   - per brand an order line of it (A: a new CONFIRMED order; B: a line on SEED-SO-B001) and a DRAFT work order of two of its
 *     cells, made through the real route as `office.all`;
 *   - one MIXED work order made before the one-customer rule (B-PR-01): a cell of each brand, no customer; written by the
 *     test's admin pool with the database's rules off for that one statement (as the copy step found such work orders);
 *   - the sessions `office.all` (every customer), `office.p1` and `office.p2` (a grant limited to that customer);
 *   - `markersOf`: everything of a brand that must never reach the other — the threads' record markers (golden-flow portal
 *     testing/two-brands.ts recordMarkers: names, codes, numbers, references, file names, ids) and its work orders' numbers,
 *     batch numbers and ids; `findMarkers` (theirs) scans an answer for them.
 *
 * Needs the core, files, production and numbering seeds of the namespace first, and an app whose test authenticator knows
 * `office.all` (twoBrandSessions). Every name, address and number is invented (`example.com`; no real company).
 */

/** The made-up style of our own collection both brands order (its code names no customer). */
export const OWN_STYLE_CODE = 'T-OWN-JKT-02'

export interface BrandInProduction {
  readonly partyId: string
  readonly salesOrderId: string
  readonly salesOrderLineId: string
  readonly workOrderId: string
  readonly workOrderNumber: string
}

export interface ProductionTwoBrands {
  readonly tenantId: string
  readonly companyId: string
  readonly siteId: string
  readonly styleId: string
  /** P1, the seeds' customer: what must never reach brand B. */
  readonly a: BrandInProduction
  /** The threads' second brand: the reader. */
  readonly b: BrandInProduction
  readonly second: SecondBrand
  /** A work order of no customer made before the rule: a cell of each brand ("Mixed brands (made before the rule)"). */
  readonly mixed: { readonly workOrderId: string; readonly number: string }
}

const grantOf = (permissions: readonly Permission[], parties: Grant['parties']): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })

/** The office sessions of the wall: every customer, and one limited to each brand (the same permissions). */
export function twoBrandSessions(tenantId: string, a: string, b: string, permissions: readonly Permission[]): Record<'office.all' | 'office.p1' | 'office.p2', SessionContext> {
  const office = (parties: Grant['parties']): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants: [grantOf(permissions, parties)] })
  return { 'office.all': office('all'), 'office.p1': office([a]), 'office.p2': office([b]) }
}

/** The ids the harness uses before it runs (its sessions name the two parties). */
export function twoBrandIds(namespace: string): { readonly tenantId: string; readonly a: string; readonly b: string } {
  const second = `ffffffff${seedUuid(namespace, 'second-brand:party').slice(8)}`
  return { tenantId: seedUuid(namespace, 'tenant'), a: seedUuid(namespace, 'party:P1'), b: second }
}

const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}

export async function productionTwoBrands(t: { readonly db: MigratedDatabase; readonly database: FactoryDatabase; readonly app: FastifyInstance; readonly namespace: string }): Promise<ProductionTwoBrands> {
  const id = (key: string) => seedUuid(t.namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyId = id('company:A')
  const siteId = id('site:A1')
  const second = await seedSecondBrand({ db: t.database, namespace: t.namespace })
  const a = id('party:P1')
  const b = second.partyId
  const styleId = newId()
  const blk = newId()
  const revisionId = newId()
  const seeded = { style: id('production:style:JKT-02'), blk: id('production:colourway:JKT-02:BLK'), revision: `ffffffff${id('production:revision:JKT-02:1').slice(8)}` }

  // Our own collection's jacket: the seed's released SEED-JKT-02 copied with no brand and no label template.
  await t.db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Style" SELECT (jsonb_populate_record(NULL::"Style", to_jsonb(s) || jsonb_build_object('id', ${sql(styleId)}, 'code', '${OWN_STYLE_CODE}', 'name', 'Our own production jacket', 'brandPartyId', NULL, 'soldUnderOurName', false))).* FROM "Style" s WHERE s.id = ${sql(seeded.style)};
     INSERT INTO "Colourway" SELECT (jsonb_populate_record(NULL::"Colourway", to_jsonb(c) || jsonb_build_object('id', ${sql(blk)}, 'styleId', ${sql(styleId)}))).* FROM "Colourway" c WHERE c.id = ${sql(seeded.blk)};
     INSERT INTO "StyleRevision" SELECT (jsonb_populate_record(NULL::"StyleRevision", to_jsonb(r) || jsonb_build_object('id', ${sql(revisionId)}, 'styleId', ${sql(styleId)}, 'labelTemplateId', NULL))).* FROM "StyleRevision" r WHERE r.id = ${sql(seeded.revision)};
     COMMIT;`,
  )

  // One order line per brand: A's on a new order of its own, B's on the threads' SEED-SO-B001. Two of each size 50 and 52 go on
  // the work order; what stays open feeds the mixed one.
  const alphaOrder = newId()
  const lines = { a: newId(), b: newId() }
  await t.database.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: alphaOrder, companyId, partyId: a, number: `T-PR03-SO-${alphaOrder.slice(-6)}`, customerRef: `T-PR03-PO-${alphaOrder.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-02T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
        select: { id: true },
      })
      for (const [key, orderId, partyId] of [['a', alphaOrder, a], ['b', second.salesOrderId, b]] as const) {
        await tx.salesOrderLine.create({
          data: { id: lines[key], companyId, orderId, partyId, seq: 900, kind: 'SIZE_GRID', styleId, colourwayId: blk, quantity: 10, unitPrice: '100.000000', netAmount: 100_000, vatRatePct: '22.00', vatAmount: 22_000 },
          select: { id: true },
        })
        await tx.salesOrderLineSize.createMany({ data: [['50', 4], ['52', 4], ['54', 2]].map(([size, quantity]) => ({ id: newId(), lineId: lines[key], partyId, size: size as string, quantity: quantity as number })) })
      }
    }),
  )

  const make = async (salesOrderLineId: string) => {
    const response = await t.app.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId, lines: [{ salesOrderLineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
    if (response.statusCode !== 201) throw new Error(`the harness's work order: ${response.statusCode} ${response.body}`)
    const { workOrder } = response.json() as { workOrder: { id: string; number: string } }
    return { workOrderId: workOrder.id, workOrderNumber: workOrder.number }
  }
  const alpha: BrandInProduction = { partyId: a, salesOrderId: alphaOrder, salesOrderLineId: lines.a, ...(await make(lines.a)) }
  const beta: BrandInProduction = { partyId: b, salesOrderId: second.salesOrderId, salesOrderLineId: lines.b, ...(await make(lines.b)) }

  // A work order made before the one-customer rule: A's work order copied with no customer, and one open cell of each brand
  // (A's size 54, B's size 52; the database's rules off for this one statement, as the copy step met such work orders).
  const mixed = { workOrderId: newId(), number: `T-PR03-MIX-${alpha.workOrderId.slice(-6)}` }
  const cellOf = (workOrderId: string, cellId: string, size: string) =>
    `INSERT INTO "WorkOrderSize" SELECT (jsonb_populate_record(NULL::"WorkOrderSize", to_jsonb(c) || jsonb_build_object('id', ${sql(cellId)}, 'workOrderId', ${sql(mixed.workOrderId)}, 'size', '${size}', 'quantity', 1))).* FROM "WorkOrderSize" c WHERE c."workOrderId" = ${sql(workOrderId)} AND c.size = '50';`
  await t.db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "WorkOrder" SELECT (jsonb_populate_record(NULL::"WorkOrder", to_jsonb(w) || jsonb_build_object('id', ${sql(mixed.workOrderId)}, 'number', '${mixed.number}', 'partyId', NULL))).* FROM "WorkOrder" w WHERE w.id = ${sql(alpha.workOrderId)};
     ${cellOf(alpha.workOrderId, newId(), '54')}
     ${cellOf(beta.workOrderId, newId(), '52')}
     COMMIT;`,
  )
  return { tenantId, companyId, siteId, styleId, a: alpha, b: beta, second, mixed }
}

/**
 * Everything of a customer that must never reach another: the threads' record markers (its names, code, contacts, addresses,
 * orders, references, files, threads, ids) and its work orders' numbers, batch numbers and ids, without repeats. Short values
 * (under 6 characters) are left out, as theirs.
 */
export async function markersOf(db: MigratedDatabase, partyId: string): Promise<Marker[]> {
  // recordMarkers reads through a golden-flow world's admin pool only; a module's PG test has the same pool on its database.
  const records = await recordMarkers({ h: { db } } as unknown as World, partyId)
  const production = (
    await db.admin.query(
      `SELECT 'work order' AS label, number AS text FROM "WorkOrder" WHERE "partyId" = $1
       UNION ALL SELECT 'work order', id::text FROM "WorkOrder" WHERE "partyId" = $1
       UNION ALL SELECT 'batch', "batchNumber" FROM "WorkOrder" WHERE "partyId" = $1`,
      [partyId],
    )
  ).rows as { label: string; text: string | null }[]
  const seen = new Set<string>()
  return [...records, ...production.filter((row): row is Marker => typeof row.text === 'string' && row.text.trim().length >= 6).map((row) => ({ label: row.label, text: row.text.trim() }))].filter((marker) => {
    const key = marker.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export { findMarkers, type Marker }

// ── B-PR-10: the manifest walker of the brand-wall sweep ───────────────────────────────────────────────────────────────────
/*
 * Which routes read a work order (production plan §2 "a sweep of every route, reads AND writes, that touches work orders";
 * 08-steps-backend B-PR-10). Derived, never hand-picked:
 *   1. the models: WorkOrder, WorkOrderSize and every model that names one of them (a relation to it, or a `workOrderId` /
 *      `workOrderSizeId` column), read from the Prisma schema folder;
 *   2. the routes: every `app.<method>('<path>', …)` of every routes file the app loads (core/autoload routesFiles — the same
 *      list the app registers; each must be a manifest entry, the boot refuses one that is not);
 *   3. the code: from each registration, the functions it names (its imports and the routes file's own functions), and from
 *      each of those the functions THEY name, to the end; a route reads a work order when one function on that walk queries
 *      one of the models (a Prisma call `.<model>.find…/count/…/update…/delete…` or a quoted table name in SQL).
 * A function is a top-level declaration of a source file (the code's layout: declarations start at the first column), an
 * object of functions counts as one (a registry of record resolvers reads every type it names). Tests and `testing/`
 * folders are not followed. The walk over-reaches rather than misses: a route it lists may read work orders only for some
 * record types (threads, files, tasks); the sweep calls it all the same.
 */

/** WorkOrder, WorkOrderSize and every model that names one of them, with their tables. */
export function workOrderModels(schemaDir: string): { readonly name: string; readonly table: string }[] {
  const models = readSchemaFolder(schemaDir)
  const parents = new Set(['WorkOrder', 'WorkOrderSize'])
  return models
    .filter((model) => parents.has(model.name) || model.fields.some((field) => (field.relation && !field.list && parents.has(field.type)) || field.column === 'workOrderId' || field.column === 'workOrderSizeId'))
    .map((model) => ({ name: model.name, table: model.table }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

/** One route the walker found, and why: the chain from its registration to the function that reads a work order. */
export interface WalkedRoute {
  /** `GET /production/work-orders/:workOrderId`: the manifest key. */
  readonly key: string
  /** The routes file, from `src/`. */
  readonly file: string
  /** `file#function` from the registration to the first function that queries one of the models; empty when none does. */
  readonly via: readonly string[]
}

interface Ref {
  readonly file: string
  readonly name: string
}
interface SourceFile {
  readonly file: string
  readonly text: string
  readonly imports: ReadonlyMap<string, Ref>
  readonly namespaces: ReadonlyMap<string, string>
  readonly reexports: ReadonlyMap<string, Ref>
  readonly stars: readonly string[]
  /** Top-level declarations: name → its text. */
  readonly declarations: ReadonlyMap<string, string>
}

const PRISMA_CALLS = 'findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy|create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany'
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|enum\s+([A-Za-z_$][\w$]*))/
const IDENTIFIER = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g

/**
 * A source file's code without its comments (each comment a space; line breaks kept), and for each line whether it starts
 * inside a string or a template literal (so a SQL text at the first column is no declaration). A small lexer: strings,
 * template literals with `${…}` inside, regular expressions (a `/` where a value starts), line and block comments.
 */
function lexed(source: string): { readonly text: string; readonly continued: readonly boolean[] } {
  let out = ''
  const continued: boolean[] = [false]
  type Mode = 'code' | 'line' | 'block' | "'" | '"' | '`' | 'regex'
  let mode: Mode = 'code'
  const braces: number[] = [] // per open `${`: the code depth inside it
  let depth = 0
  let inClass = false
  let last = '' // the last code character that is not a space
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '\n') {
      if (mode === 'line') mode = 'code'
      out += '\n'
      continued.push(mode !== 'code' && mode !== 'block')
      continue
    }
    switch (mode) {
      case 'line':
        continue
      case 'block':
        if (c === '*' && next === '/') {
          mode = 'code'
          i++
        }
        continue
      case "'":
      case '"':
        out += c
        if (c === '\\') out += source[++i] ?? ''
        else if (c === mode) mode = 'code'
        continue
      case '`':
        out += c
        if (c === '\\') out += source[++i] ?? ''
        else if (c === '`') mode = 'code'
        else if (c === '$' && next === '{') {
          out += '{'
          i++
          braces.push(depth)
          mode = 'code'
        }
        continue
      case 'regex':
        out += c
        if (c === '\\') out += source[++i] ?? ''
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) mode = 'code'
        continue
      case 'code':
        if (c === '/' && next === '/') {
          mode = 'line'
          out += ' '
          continue
        }
        if (c === '/' && next === '*') {
          mode = 'block'
          out += ' '
          i++
          continue
        }
        if (c === "'" || c === '"' || c === '`') mode = c
        else if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /\breturn\s*$/.test(out))) {
          mode = 'regex'
          inClass = false
        } else if (c === '{') depth++
        else if (c === '}') {
          if (braces.length > 0 && braces[braces.length - 1] === depth) {
            braces.pop()
            mode = '`'
          } else depth--
        }
        out += c
        if (!/\s/.test(c)) last = c
    }
  }
  return { text: out, continued }
}

const NOT_CODE = /^(?:import\s|import\{|export\s+(?:type\s+)?\{|export\s+\*|(?:export\s+)?(?:declare\s+)?(?:type|interface)\s)/

/**
 * The routes of `srcRoot` (the folder of `platform/` and `modules/`) whose handlers read WorkOrder, WorkOrderSize or a model
 * that names one of them; with `all: true` every route, `via` empty for those that read none.
 */
export function walkWorkOrderRoutes(input: { readonly srcRoot: string; readonly schemaDir: string; readonly all?: boolean }): WalkedRoute[] {
  const models = workOrderModels(input.schemaDir)
  const accessors = models.map((model) => model.name[0]!.toLowerCase() + model.name.slice(1))
  const reads = new RegExp(`\\.(?:${accessors.join('|')})\\s*\\.\\s*(?:${PRISMA_CALLS})\\b|"(?:${models.map((model) => model.table).join('|')})"`)
  const files = new Map<string, SourceFile>()
  const resolveImport = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null // packages: the domain is pure logic, the database package is the client
    const base = resolve(dirname(from), specifier)
    const found = [`${base}.ts`, join(base, 'index.ts')].find((path) => existsSync(path) && statSync(path).isFile())
    return found && !/\.test\.ts$/.test(found) && !/[\\/]testing[\\/]/.test(found) ? found : null
  }
  const names = (list: string): [string, string][] =>
    list
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !part.startsWith('type '))
      .map((part) => {
        const [original, alias] = part.split(/\s+as\s+/) as [string, string | undefined]
        return [(alias ?? original).trim(), original.trim()]
      })
  const parse = (file: string): SourceFile => {
    const known = files.get(file)
    if (known) return known
    const { text, continued } = lexed(readFileSync(file, 'utf8'))
    const imports = new Map<string, Ref>()
    const namespaces = new Map<string, string>()
    const reexports = new Map<string, Ref>()
    const stars: string[] = []
    for (const match of text.matchAll(/^\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
      const target = match[1] ? null : resolveImport(file, match[3]!)
      if (!target) continue
      const named = match[2]!.match(/\{([\s\S]*)\}/)
      if (named) for (const [local, original] of names(named[1]!)) imports.set(local, { file: target, name: original })
      const head = match[2]!.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim()
      const namespace = head.match(/\*\s+as\s+([\w$]+)/)
      if (namespace) namespaces.set(namespace[1]!, target)
      else if (head !== '') imports.set(head.split(/\s+/)[0]!, { file: target, name: 'default' })
    }
    for (const match of text.matchAll(/^\s*export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
      const target = match[1] ? null : resolveImport(file, match[3]!)
      if (target) for (const [exported, original] of names(match[2]!)) reexports.set(exported, { file: target, name: original })
    }
    for (const match of text.matchAll(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) {
      const target = resolveImport(file, match[1]!)
      if (target) stars.push(target)
    }
    const declarations = new Map<string, string>()
    let current: { names: string[]; lines: string[] } | null = null
    const close = () => {
      if (current) for (const name of current.names) declarations.set(name, `${declarations.get(name) ?? ''}${current.lines.join('\n')}\n`)
    }
    text.split('\n').forEach((line, index) => {
      // A declaration starts at the first column (not a closing bracket, not inside a string or a template literal).
      if (!continued[index] && /^[^\s}\])]/.test(line)) {
        close()
        if (NOT_CODE.test(line)) {
          current = null
          return
        }
        current = { names: [], lines: [] }
        const declared = line.match(DECLARATION)
        const name = declared ? (declared[1] ?? declared[2] ?? declared[3] ?? declared[4]) : undefined
        if (name) current.names.push(name)
        if (/^export\s+default\b/.test(line)) current.names.push('default')
      }
      current?.lines.push(line)
    })
    close()
    const parsed: SourceFile = { file, text, imports, namespaces, reexports, stars, declarations }
    files.set(file, parsed)
    return parsed
  }
  const refsIn = (source: SourceFile, text: string): Ref[] => {
    const out: Ref[] = []
    // The words of a quoted string name no function (an address, a message); a template literal's `${…}` may.
    for (const match of text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''").matchAll(IDENTIFIER)) {
      const [head, member] = match[0].split(/\s*\.\s*/) as [string, string | undefined]
      if (member && source.namespaces.has(head)) out.push({ file: source.namespaces.get(head)!, name: member })
      const imported = source.imports.get(head)
      if (imported) out.push(imported)
      // A routes file's registrations sit inside its own default export: never "the whole file" again.
      else if (head !== 'default' && source.declarations.has(head)) out.push({ file: source.file, name: head })
    }
    return out
  }
  /** The function a reference lands on (through re-exports), its text and what it names; null for a type or a constant of a package. */
  const land = (ref: Ref, depth = 0): { readonly key: string; readonly text: string; readonly source: SourceFile } | null => {
    if (depth > 20) return null
    const source = parse(ref.file)
    const text = source.declarations.get(ref.name)
    if (text !== undefined) return { key: `${relative(input.srcRoot, ref.file)}#${ref.name}`, text, source }
    const again = source.reexports.get(ref.name)
    if (again) return land(again, depth + 1)
    for (const star of source.stars) {
      const found = land({ file: star, name: ref.name }, depth + 1)
      if (found) return found
    }
    return null
  }
  const direct = new Map<string, boolean>()
  const readsDirectly = (key: string, text: string): boolean => {
    if (!direct.has(key)) direct.set(key, reads.test(text))
    return direct.get(key)!
  }
  const edges = new Map<string, Ref[]>()
  /** The shortest walk from `start` (a registration's text in its routes file) to a function that queries one of the models. */
  const walk = (source: SourceFile, start: string, startKey: string): string[] => {
    if (reads.test(start)) return [startKey]
    const parent = new Map<string, string | null>([[startKey, null]])
    const queue: { key: string; refs: Ref[] }[] = [{ key: startKey, refs: refsIn(source, start) }]
    while (queue.length > 0) {
      const { key, refs } = queue.shift()!
      for (const ref of refs) {
        const landed = land(ref)
        if (!landed || parent.has(landed.key)) continue
        parent.set(landed.key, key)
        if (readsDirectly(landed.key, landed.text)) {
          const chain: string[] = []
          for (let at: string | null = landed.key; at !== null; at = parent.get(at) ?? null) chain.unshift(at)
          return chain
        }
        if (!edges.has(landed.key)) edges.set(landed.key, refsIn(landed.source, landed.text))
        queue.push({ key: landed.key, refs: edges.get(landed.key)! })
      }
    }
    return []
  }
  const out: WalkedRoute[] = []
  for (const routesFile of routesFiles(input.srcRoot)) {
    const source = parse(routesFile)
    const file = relative(input.srcRoot, routesFile)
    const registrations = [...source.text.matchAll(REGISTRATION)]
    registrations.forEach((match, index) => {
      const text = source.text.slice(match.index, index + 1 < registrations.length ? registrations[index + 1]!.index : source.text.length)
      const key = `${match[1]!.toUpperCase()} ${match[2]}`
      const via = walk(source, text, `${file}#${key}`)
      if (via.length > 0 || input.all) out.push({ key, file, via })
    })
  }
  return out
}

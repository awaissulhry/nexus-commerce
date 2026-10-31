import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { policySql, PolicyModelError, type PolicyModel, type Privilege, type RoleAccess, type TablePolicy } from '@nexus/db-kit/policy-sql'
import { FLOOR_ROLE, keysSetBy, PARTNER_ROLE, PLATFORM_ROLE, POLICY_KEYS, RUNTIME_ROLES, TENANT_ID_DEFAULT, WALL } from './roles'
import type { SchemaModel } from './schema-models'

/**
 * Model ownership (Commerce hard rule 5, for the factory): every Prisma model is classified in `ownership/<module>.json`,
 * the file named after its `prisma/schema/<module>.prisma`. An unclassified model gets no grant and no policy, so the
 * runtime roles cannot touch it; `scripts/factory/check-ownership.mjs` fails until it is classified.
 *
 *   kind "tenant"    behind the tenant wall: a `tenantId` column with the standard default; keyColumns.tenant = tenantId.
 *   kind "platform"  outside any tenant (Tenant itself): no tenantId column; factory_platform reads and writes every row,
 *                    a runtime role that is listed too sees only its own tenant's rows (keyColumns.tenant).
 *
 * Per model: `keyColumns` (key → column the policies compare with the scope: tenant, site, party) and `access` (role →
 * privileges, the extra keys its rows must match, the columns it may not read or write, and `onlyValues`: column →
 * the only values its rows may hold, e.g. the floor's document kinds of NumberSeries). The floor role is scoped by site
 * wherever the table has a site key, the partner role always by party.
 *
 * The partner wall (plan A1 §2.2, §2.6; features PLT-007, PLT-035): portal and one-off link sessions
 * (factory_partner_runtime) never read or write a cost, margin or wages column, nor an internal note. Such a column is
 * marked in the schema (`/// @grain cost|margin|wages` above it, which check-money-grains requires of every
 * money-looking column; `/// @internal` for an office-only note), and every partner access to its table must list it in
 * hiddenColumns, so the column grants leave it out. A price column (`@grain price`) stays readable: the party scope
 * keeps the partner to its own documents, and the API drops prices for a link whose purpose shows none.
 *
 * Personal data (W2b, features PLT-207 "personal-data field tagging", PLT-209 "purpose tags on worker data"): a model
 * that holds data about one person lists it in `personal`: `subject`, the column that names the person (the model's own
 * `id` for Employee, `employeeId` elsewhere; with `via`, a reference to a model whose own subject is the person), and
 * `columns`, each personal column with the purposes it may be used for (PERSONAL_PURPOSES). The privacy export and
 * erasure read the map (`personalDataOf`), and the tags drive field security: the partner role never reads a personal
 * column, and the floor reads one only for a purpose its tools serve (production, attendance, safety); hide the others.
 */

/** The doc tags that put a column behind the partner wall, with why. */
export const PARTNER_WALL_TAGS: Readonly<Record<string, string>> = {
  '@grain cost': 'a cost (@grain cost)',
  '@grain margin': 'a margin (@grain margin)',
  '@grain wages': 'wages (@grain wages)',
  '@internal': 'an internal note (@internal)',
}

const hasTag = (tags: readonly string[], tag: string): boolean => tags.some((entry) => entry === tag || (tag === '@internal' && entry.startsWith('@internal ')))

/** The columns of a model the partner role may never read or write, each with why. */
export function partnerWalledColumns(model: SchemaModel): { readonly column: string; readonly why: string }[] {
  return model.fields.flatMap((field) => {
    if (field.relation) return []
    const tag = Object.keys(PARTNER_WALL_TAGS).find((candidate) => hasTag(field.tags ?? [], candidate))
    return tag ? [{ column: field.column, why: PARTNER_WALL_TAGS[tag] as string }] : []
  })
}

export type ModelKind = 'tenant' | 'platform'

/**
 * The purposes personal data may be used for (PLT-209), each with the rule it rests on. A personal column lists one or
 * more; a use outside them needs a new purpose, decided by a person, never a quiet reuse.
 */
export const PERSONAL_PURPOSES = {
  /** Running the employment: who the person is, their contract, company, site, line, team, role (GDPR art. 6(1)(b), art. 88). */
  EMPLOYMENT: 'employment',
  /** Working time and presence: clock-in, attendance, the LUL calendar (Statuto dei Lavoratori art. 4 c.2; D.Lgs. 66/2003). */
  ATTENDANCE: 'attendance',
  /** One person's work figures (Statuto art. 4 c.1: a union agreement or the Ispettorato's authorisation). */
  PERFORMANCE: 'performance',
  /** Pay and the payroll: piece rates, earnings, the export to the labour consultant (c.c. arts. 2099-2101). */
  PAY: 'pay',
  /** Health and safety at work: skills, training, machine authorisations; never health data (D.Lgs. 81/2008). */
  SAFETY: 'safety',
  /** Traceability of what was made and by whom on the floor (MES-278; the worker notice). */
  PRODUCTION: 'production',
} as const
export type PersonalPurpose = keyof typeof PERSONAL_PURPOSES
/** The purposes of the floor's tools: a personal column the floor role reads carries one of them. */
export const FLOOR_PURPOSES: readonly PersonalPurpose[] = ['PRODUCTION', 'ATTENDANCE', 'SAFETY']

/** Which person a model's rows are about, and its personal columns with their purposes. */
export interface PersonalData {
  /** The column that names the person: the model's id (Employee), or a reference such as employeeId. */
  readonly subject: string
  /** The model `subject` references, when the person is that model's subject (a leaver step's case). */
  readonly via?: string
  readonly columns: Readonly<Record<string, readonly PersonalPurpose[]>>
}

export interface ModelOwnership {
  readonly about?: string
  readonly kind: ModelKind
  readonly keyColumns?: Readonly<Record<string, string>>
  readonly access: Readonly<Record<string, RoleAccess>>
  readonly personal?: PersonalData
}

/** One `ownership/<module>.json` file as read: its name and its parsed (not yet checked) content. */
export interface OwnershipFile {
  /** `_core.json` */
  readonly file: string
  readonly data: unknown
}

/** What the policy SQL is generated from: the walled model for db-kit, and the platform role's tables. */
export interface PolicyInputs {
  readonly model: PolicyModel
  readonly platformTables: readonly PlatformTable[]
}

export interface PlatformTable {
  readonly table: string
  readonly privileges: readonly Privilege[]
  /** Whether the table is also in the walled model (a runtime role reads its own tenant's row). */
  readonly walled: boolean
}

export class OwnershipError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Model ownership: ${violations.length} problem(s)\n  ${violations.join('\n  ')}`)
    this.name = 'OwnershipError'
  }
}

const MODEL_KEYS = new Set(['about', 'kind', 'keyColumns', 'access', 'personal'])
const PERSONAL_KEYS = new Set(['subject', 'via', 'columns'])
const ACCESS_KEYS = new Set(['privileges', 'scopedBy', 'hiddenColumns', 'onlyValues'])
const PRIVILEGES: readonly Privilege[] = ['select', 'insert', 'update', 'delete']

/** Reads every `ownership/*.json` file. A file that is not valid JSON is an error. */
export function readOwnershipFolder(dir: string): OwnershipFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new OwnershipError([`ownership/${name} is not valid JSON: ${(error as Error).message}`])
      }
      return { file: basename(name), data: parsed }
    })
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Every problem with the classification, as readable lines. Empty when it is complete and consistent. */
export function checkOwnership(models: readonly SchemaModel[], files: readonly OwnershipFile[]): string[] {
  const { problems, entries } = validate(models, files)
  if (problems.length > 0) return problems
  try {
    policySql(build(models, entries).model)
  } catch (error) {
    if (!(error instanceof PolicyModelError)) throw error
    return [`the policy generator refuses the classification: ${error.message}`]
  }
  return []
}

/** The inputs of the policy generator. Throws `OwnershipError` listing every problem `checkOwnership` would report. */
export function policyInputs(models: readonly SchemaModel[], files: readonly OwnershipFile[]): PolicyInputs {
  const { problems, entries } = validate(models, files)
  if (problems.length > 0) throw new OwnershipError(problems)
  return build(models, entries)
}

/** One model's personal data, for the privacy export and erasure (PLT-207). */
export interface PersonalDataEntry extends PersonalData {
  readonly model: string
  readonly table: string
}

/** Every model that holds personal data, with its subject and tagged columns. Throws like `policyInputs`. */
export function personalDataOf(models: readonly SchemaModel[], files: readonly OwnershipFile[]): PersonalDataEntry[] {
  return classifiedModels(models, files).flatMap(({ model, ownership }) => (ownership.personal ? [{ model: model.name, table: model.table, ...ownership.personal }] : []))
}

/** Every model with its checked classification (the generated isolation tests use it). Throws like `policyInputs`. */
export function classifiedModels(models: readonly SchemaModel[], files: readonly OwnershipFile[]): { model: SchemaModel; ownership: ModelOwnership }[] {
  const { problems, entries } = validate(models, files)
  if (problems.length > 0) throw new OwnershipError(problems)
  return models.map((model) => ({ model, ownership: entries.get(model.name) as ModelOwnership }))
}

function validate(models: readonly SchemaModel[], files: readonly OwnershipFile[]): { problems: string[]; entries: Map<string, ModelOwnership> } {
  const problems: string[] = []
  const entries = new Map<string, ModelOwnership>()
  const byName = new Map(models.map((model) => [model.name, model]))
  const classifiedIn = new Map<string, string>()

  for (const file of files) {
    const where = `ownership/${file.file}`
    const raw = file.data
    if (!isObject(raw)) {
      problems.push(`${where}: the top level must be an object`)
      continue
    }
    for (const key of Object.keys(raw)) if (key !== '$comment' && key !== 'models') problems.push(`${where}: unknown top-level key "${key}"`)
    if (!isObject(raw.models)) {
      problems.push(`${where}: "models" must be an object`)
      continue
    }
    const module = file.file.replace(/\.json$/, '')
    for (const [name, entry] of Object.entries(raw.models)) {
      const at = `${where}: ${name}`
      const earlier = classifiedIn.get(name)
      if (earlier) {
        problems.push(`${at} is classified twice (also in ownership/${earlier})`)
        continue
      }
      classifiedIn.set(name, file.file)
      const model = byName.get(name)
      if (!model) {
        problems.push(`${at} is not a model of prisma/schema/*.prisma`)
        continue
      }
      if (model.file !== `${module}.prisma`) problems.push(`${at} is defined in prisma/schema/${model.file}; classify it in ownership/${model.file.replace(/\.prisma$/, '.json')}`)
      const found = [...checkModel(at, model, entry), ...checkPersonal(at, model, entry)]
      problems.push(...found)
      if (found.length === 0) entries.set(name, entry as unknown as ModelOwnership)
    }
  }
  // A subject reached through another model needs that model's own subject.
  for (const [name, entry] of entries) {
    const via = entry.personal?.via
    if (via !== undefined && !entries.get(via)?.personal) problems.push(`ownership/${classifiedIn.get(name)}: ${name}: personal.via names ${via}, which lists no personal data of its own (its subject is the person)`)
  }
  for (const model of models) {
    if (!classifiedIn.has(model.name)) {
      problems.push(
        `prisma/schema/${model.file}: model ${model.name} is not classified; add it to ownership/${model.file.replace(/\.prisma$/, '.json')} (without it the runtime roles get no grant and no policy)`,
      )
    }
  }
  return { problems, entries }
}

function checkModel(at: string, model: SchemaModel, entry: unknown): string[] {
  const problems: string[] = []
  if (!isObject(entry)) return [`${at} must be an object`]
  for (const key of Object.keys(entry)) if (!MODEL_KEYS.has(key)) problems.push(`${at}: unknown key "${key}"`)
  const kind = entry.kind
  if (kind !== 'tenant' && kind !== 'platform') problems.push(`${at}: kind must be "tenant" or "platform"`)
  const columns = new Set(model.columns)
  const keyColumns = entry.keyColumns ?? {}
  if (!isObject(keyColumns)) return [...problems, `${at}: keyColumns must be an object`]
  for (const [key, column] of Object.entries(keyColumns)) {
    if (!Object.hasOwn(POLICY_KEYS, key)) problems.push(`${at}: keyColumns names an unknown key "${key}" (known: ${Object.keys(POLICY_KEYS).join(', ')})`)
    if (typeof column !== 'string' || !columns.has(column)) problems.push(`${at}: key column ${String(column)} is not a column of ${model.name}`)
  }
  for (const [key, column] of [
    ['site', 'siteId'],
    ['party', 'partyId'],
  ] as const) {
    if (columns.has(column) && keyColumns[key] !== column) problems.push(`${at}: it has a ${column} column, so keyColumns.${key} must be "${column}"`)
  }

  const tenantField = model.fields.find((field) => field.name === 'tenantId')
  if (kind === 'tenant') {
    if (keyColumns.tenant !== 'tenantId') problems.push(`${at}: a tenant model needs keyColumns.tenant = "tenantId"`)
    if (!tenantField || tenantField.type !== 'String' || tenantField.optional || tenantField.nativeType !== 'Uuid') {
      problems.push(`${at}: a tenant model needs a required column tenantId String @db.Uuid`)
    } else if (tenantField.defaultValue !== `dbgenerated(${JSON.stringify(TENANT_ID_DEFAULT)})`) {
      problems.push(`${at}: tenantId must have @default(dbgenerated(${JSON.stringify(TENANT_ID_DEFAULT)}))`)
    }
  }
  if (kind === 'platform' && tenantField) problems.push(`${at}: a platform model has no tenantId column; a table with one is kind "tenant"`)

  const access = entry.access
  if (!isObject(access) || Object.keys(access).length === 0) return [...problems, `${at}: access must name at least one role`]
  for (const [role, grant] of Object.entries(access)) {
    const where = `${at}: ${role}`
    if (!(RUNTIME_ROLES as readonly string[]).includes(role)) {
      problems.push(`${where} is not a runtime role (${RUNTIME_ROLES.join(', ')})`)
      continue
    }
    if (!isObject(grant)) {
      problems.push(`${where} must be an object`)
      continue
    }
    for (const key of Object.keys(grant)) if (!ACCESS_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`)
    const privileges = grant.privileges
    if (!Array.isArray(privileges) || privileges.length === 0 || privileges.some((p) => !PRIVILEGES.includes(p as Privilege))) {
      problems.push(`${where}: privileges must list some of ${PRIVILEGES.join(', ')}`)
    } else if (new Set(privileges).size !== privileges.length) problems.push(`${where}: a privilege is listed twice`)
    const scopedBy = (grant.scopedBy ?? []) as unknown
    const hidden = (grant.hiddenColumns ?? []) as unknown
    if (!Array.isArray(scopedBy) || !Array.isArray(hidden)) {
      problems.push(`${where}: scopedBy and hiddenColumns must be lists`)
      continue
    }
    for (const column of hidden) if (!columns.has(column)) problems.push(`${where}: hidden column ${String(column)} is not a column of ${model.name}`)
    const only = (grant.onlyValues ?? {}) as unknown
    if (!isObject(only)) problems.push(`${where}: onlyValues must be an object (column → values)`)
    else {
      for (const [column, values] of Object.entries(only)) {
        if (!columns.has(column)) problems.push(`${where}: onlyValues names ${column}, which is not a column of ${model.name}`)
        if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) problems.push(`${where}: onlyValues.${column} must list at least one value`)
        if (hidden.includes(column)) problems.push(`${where}: onlyValues reads ${column}, so it cannot be hidden`)
      }
      if (role === PLATFORM_ROLE && Object.keys(only).length > 0) problems.push(`${where}: factory_platform takes no onlyValues`)
    }
    const allowed = new Set<string>(keysSetBy(role))
    for (const key of scopedBy) {
      if (!allowed.has(key)) problems.push(`${where}: scopedBy ${String(key)}, which ${role}'s scope does not set`)
      if (!Object.hasOwn(keyColumns, key)) problems.push(`${where}: scopedBy ${String(key)}, which has no key column`)
    }
    if (role === PLATFORM_ROLE) {
      if (kind !== 'platform') problems.push(`${where}: factory_platform reaches only platform models`)
      if (scopedBy.length > 0 || hidden.length > 0) problems.push(`${where}: factory_platform takes no scopedBy and no hiddenColumns`)
    }
    if (role === FLOOR_ROLE && keyColumns.site !== undefined && !scopedBy.includes('site')) {
      problems.push(`${where}: the floor role must be scopedBy site on a table with a site key`)
    }
    if (role === PARTNER_ROLE && !scopedBy.includes('party')) problems.push(`${where}: the partner role must be scopedBy party`)
    if (role === PARTNER_ROLE) {
      for (const { column, why } of partnerWalledColumns(model)) {
        if (!hidden.includes(column)) problems.push(`${where}: column ${column} is ${why}, behind the partner wall; add it to hiddenColumns`)
      }
    }
    for (const key of WALL) {
      if (role !== PLATFORM_ROLE && keyColumns[key] === undefined) problems.push(`${where}: no column for the ${key} wall (keyColumns.${key})`)
    }
  }
  if (kind === 'platform' && !Object.hasOwn(access, PLATFORM_ROLE)) problems.push(`${at}: a platform model is for factory_platform; list it in access`)
  return problems
}

/** The `personal` entry: the subject column, the tagged columns and their purposes, and what the tags allow. */
function checkPersonal(at: string, model: SchemaModel, entry: unknown): string[] {
  if (!isObject(entry) || entry.personal === undefined) return []
  const where = `${at}: personal`
  const personal = entry.personal
  if (!isObject(personal)) return [`${where} must be an object { subject, via?, columns }`]
  const problems: string[] = []
  for (const key of Object.keys(personal)) if (!PERSONAL_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`)
  const subject = model.fields.find((field) => !field.relation && field.column === personal.subject)
  if (!subject || subject.type !== 'String' || subject.nativeType !== 'Uuid') problems.push(`${where}: subject ${String(personal.subject)} is not a uuid column of ${model.name} (the column that names the person)`)
  if (personal.via !== undefined && (typeof personal.via !== 'string' || personal.via === model.name)) problems.push(`${where}: via must name another model`)
  const columns = personal.columns
  if (!isObject(columns) || Object.keys(columns).length === 0) return [...problems, `${where}: columns must tag at least one column with its purposes`]
  const access = isObject(entry.access) ? entry.access : {}
  const hiddenFrom = (role: string): Set<string> | undefined => {
    const grant = access[role]
    if (!isObject(grant)) return undefined
    return new Set(Array.isArray(grant.hiddenColumns) ? (grant.hiddenColumns as string[]) : [])
  }
  const partnerHidden = hiddenFrom(PARTNER_ROLE)
  const floorHidden = hiddenFrom(FLOOR_ROLE)
  for (const [column, purposes] of Object.entries(columns)) {
    if (!model.columns.includes(column)) {
      problems.push(`${where}: ${column} is not a column of ${model.name}`)
      continue
    }
    if (column === personal.subject) problems.push(`${where}: ${column} is the subject; tag the other columns`)
    if (!Array.isArray(purposes) || purposes.length === 0 || purposes.some((purpose) => !Object.hasOwn(PERSONAL_PURPOSES, purpose as string))) {
      problems.push(`${where}: ${column} must list one or more purposes of ${Object.keys(PERSONAL_PURPOSES).join(', ')}`)
      continue
    }
    if (new Set(purposes).size !== purposes.length) problems.push(`${where}: ${column} lists a purpose twice`)
    if (partnerHidden && !partnerHidden.has(column)) problems.push(`${where}: ${column} is personal data; the partner role never reads it (add it to its hiddenColumns)`)
    if (floorHidden && !floorHidden.has(column) && !(purposes as string[]).some((purpose) => (FLOOR_PURPOSES as readonly string[]).includes(purpose))) {
      problems.push(`${where}: the floor reads ${column}, whose purposes (${(purposes as string[]).join(', ')}) are none of the floor's (${FLOOR_PURPOSES.join(', ')}); hide it from the floor or name the purpose`)
    }
  }
  return problems
}

function build(models: readonly SchemaModel[], entries: ReadonlyMap<string, ModelOwnership>): PolicyInputs {
  const tables: TablePolicy[] = []
  const platformTables: PlatformTable[] = []
  for (const model of models) {
    const entry = entries.get(model.name)
    if (entry) {
      const walled = Object.entries(entry.access).filter(([role]) => role !== PLATFORM_ROLE)
      if (walled.length > 0) {
        tables.push({ table: model.table, columns: model.columns, keyColumns: entry.keyColumns ?? {}, access: Object.fromEntries(walled) })
      }
      const platform = entry.access[PLATFORM_ROLE]
      if (platform) platformTables.push({ table: model.table, privileges: platform.privileges, walled: walled.length > 0 })
    }
  }
  return {
    model: { roles: RUNTIME_ROLES, keys: POLICY_KEYS, alwaysScopedBy: WALL, tables },
    platformTables: platformTables.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0)),
  }
}

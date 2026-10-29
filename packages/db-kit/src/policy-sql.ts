/**
 * The policy SQL generator, the generic successor of Commerce's `scripts/workspace-policies.mjs`. From a small
 * declarative model (which roles exist, which settings scope a row, and per table which role may do what on which
 * columns) it writes idempotent SQL:
 *   - ENABLE and FORCE ROW LEVEL SECURITY (forced: the table owner obeys the policies too);
 *   - one policy per role and command, reading `current_setting('<setting>', true)`; an unset or empty setting
 *     matches no row (default deny); a role may also be kept to the rows whose column holds one of a few listed values
 *     (`onlyValues`, e.g. some kinds of a table's rows);
 *   - grants: table-level for a role that sees every column, column-level (`GRANT SELECT (…)`) that leaves out the
 *     hidden columns for the others.
 *
 * Fail closed, and convergent: applying it twice changes nothing, and applying a newer model removes what the older one
 * granted. It drops EVERY policy on a managed table before creating its own (a stray permissive policy would widen
 * access) and revokes everything from PUBLIC and every managed role before granting. The output is sorted (tables,
 * roles, columns, keys), so it does not depend on the order of the input and can be checked in.
 *
 * Pure: no database, no file, no environment.
 */

export type Privilege = 'select' | 'insert' | 'update' | 'delete'

export interface PolicyKey {
  /** The setting the policies read, e.g. `factory.tenant_id`. */
  readonly setting: string
  /** The SQL type the setting is cast to; it must match the key columns' type (e.g. `uuid`, `text`). */
  readonly type: string
}

export interface RoleAccess {
  /** What the role may do on the table. A policy is made for each command, and only for these. */
  readonly privileges: readonly Privilege[]
  /** Keys this role's rows must also match on this table, beyond the model's `alwaysScopedBy` (e.g. `['site']`). */
  readonly scopedBy?: readonly string[]
  /** Columns the role may neither read nor write (cost, margin, price, internal notes …). */
  readonly hiddenColumns?: readonly string[]
  /**
   * Rows this role may reach only when a column holds one of the listed values (column → values), beside the keys: e.g.
   * `{ kind: ['LOT', 'GOODS_RECEIPT'] }` keeps a role to the rows of those kinds, for reads and writes alike (a row of
   * another value is not seen, not locked, not changed, and cannot be written). Compared as text, so it fits an enum or
   * a text column. Values are plain names (letters, digits, `_`, `-`, `.`).
   */
  readonly onlyValues?: Readonly<Record<string, readonly string[]>>
}

export interface TablePolicy {
  readonly table: string
  /** Default `public`. */
  readonly schema?: string
  /** Every column of the table. Needed for column grants, and checked against every column named below. */
  readonly columns: readonly string[]
  /** The column that holds each key on this table, e.g. `{ tenant: 'tenantId', site: 'siteId' }`. */
  readonly keyColumns: Readonly<Record<string, string>>
  /** Role → access. A managed role that is not listed gets nothing on this table. */
  readonly access: Readonly<Record<string, RoleAccess>>
}

export interface PolicyModel {
  /** Every role this SQL manages. Each managed table revokes everything from all of them before granting. */
  readonly roles: readonly string[]
  /** Key name → setting, e.g. `{ tenant: { setting: 'factory.tenant_id', type: 'uuid' } }`. */
  readonly keys: Readonly<Record<string, PolicyKey>>
  /** Keys EVERY policy checks (the wall), e.g. `['tenant']`. At least one. */
  readonly alwaysScopedBy: readonly string[]
  readonly tables: readonly TablePolicy[]
}

const PRIVILEGES: readonly Privilege[] = ['select', 'insert', 'update', 'delete']
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/
const SETTING = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/
const TYPE = /^[a-z][a-z0-9_]*$/
const VALUE = /^[A-Za-z0-9_.-]{1,63}$/

export class PolicyModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyModelError'
  }
}

const fail = (message: string): never => {
  throw new PolicyModelError(message)
}
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byCodePoint)

function identifier(name: unknown, what: string): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) fail(`Invalid ${what}: ${JSON.stringify(name)}.`)
  return `"${name as string}"`
}
function role(name: unknown): string {
  if (typeof name !== 'string' || !ROLE.test(name)) fail(`Invalid role: ${JSON.stringify(name)} (lower case, at most 63 characters).`)
  return `"${name as string}"`
}
const tableName = (table: TablePolicy): string => `${identifier(table.schema ?? 'public', 'schema')}.${identifier(table.table, 'table')}`

function checkModel(model: PolicyModel): void {
  if (!Array.isArray(model.roles) || model.roles.length === 0) fail('A policy model needs at least one managed role.')
  model.roles.forEach(role)
  for (const [name, key] of Object.entries<PolicyKey>(model.keys ?? {})) {
    if (!IDENTIFIER.test(name)) fail(`Invalid key name: ${JSON.stringify(name)}.`)
    if (typeof key?.setting !== 'string' || !SETTING.test(key.setting)) fail(`Key ${name} needs a lower-case dotted setting name.`)
    if (typeof key.type !== 'string' || !TYPE.test(key.type)) fail(`Key ${name} needs a plain SQL type name.`)
  }
  if (!Array.isArray(model.alwaysScopedBy) || model.alwaysScopedBy.length === 0) {
    fail('alwaysScopedBy must name at least one key: every policy checks the wall.')
  }
  for (const key of model.alwaysScopedBy) if (!Object.hasOwn(model.keys, key)) fail(`alwaysScopedBy names an unknown key: ${key}.`)
  const seen = new Set<string>()
  for (const table of model.tables) {
    const name = tableName(table)
    if (seen.has(name)) fail(`Table ${name} is listed twice.`)
    seen.add(name)
    checkTable(model, table, name)
  }
}

function checkTable(model: PolicyModel, table: TablePolicy, name: string): void {
  if (!Array.isArray(table.columns) || table.columns.length === 0) fail(`${name} lists no columns.`)
  table.columns.forEach((column) => identifier(column, `column of ${name}`))
  const columns = new Set(table.columns)
  if (columns.size !== table.columns.length) fail(`${name} lists a column twice.`)
  for (const [key, column] of Object.entries(table.keyColumns ?? {})) {
    if (!Object.hasOwn(model.keys, key)) fail(`${name} maps an unknown key: ${key}.`)
    if (!columns.has(column)) fail(`${name}: key column ${column} is not one of its columns.`)
  }
  const managed = new Set(model.roles)
  const entries = Object.entries<RoleAccess>(table.access ?? {})
  if (entries.length === 0) fail(`${name} grants no role anything; leave it out of the model instead.`)
  for (const [roleName, access] of entries) {
    if (!managed.has(roleName)) fail(`${name}: role ${roleName} is not a managed role.`)
    const privileges = access?.privileges
    if (!Array.isArray(privileges) || privileges.length === 0) fail(`${name}: role ${roleName} has no privileges.`)
    for (const privilege of privileges) if (!PRIVILEGES.includes(privilege)) fail(`${name}: unknown privilege ${String(privilege)}.`)
    if (new Set(privileges).size !== privileges.length) fail(`${name}: role ${roleName} lists a privilege twice.`)
    for (const key of scopeKeys(model, access)) {
      if (!Object.hasOwn(model.keys, key)) fail(`${name}: role ${roleName} is scoped by an unknown key: ${key}.`)
      if (!Object.hasOwn(table.keyColumns, key)) fail(`${name} has no column for key ${key}, which role ${roleName} needs.`)
    }
    const hidden = access.hiddenColumns ?? []
    for (const column of hidden) if (!columns.has(column)) fail(`${name}: hidden column ${column} is not one of its columns.`)
    const policyColumns = new Set(scopeKeys(model, access).map((key) => table.keyColumns[key]))
    for (const column of hidden) {
      if (policyColumns.has(column)) fail(`${name}: role ${roleName} cannot hide ${column}, its own policy reads it.`)
    }
    if (hidden.length > 0 && columns.size - new Set(hidden).size === 0) fail(`${name}: role ${roleName} would see no column.`)
    for (const [column, values] of Object.entries(access.onlyValues ?? {})) {
      if (!columns.has(column)) fail(`${name}: role ${roleName} filters on ${column}, which is not one of its columns.`)
      if (hidden.includes(column)) fail(`${name}: role ${roleName} cannot hide ${column}, its own policy reads it.`)
      if (!Array.isArray(values) || values.length === 0) fail(`${name}: role ${roleName} lists no value for ${column}.`)
      for (const value of values) if (typeof value !== 'string' || !VALUE.test(value)) fail(`${name}: role ${roleName} has an invalid value for ${column}: ${JSON.stringify(value)}.`)
      if (new Set(values).size !== values.length) fail(`${name}: role ${roleName} lists a value of ${column} twice.`)
    }
    for (const privilege of privileges) {
      const policy = `${roleName}_${privilege}`
      if (policy.length > 63) fail(`${name}: policy name ${policy} is longer than 63 characters.`)
    }
  }
}

const scopeKeys = (model: PolicyModel, access: RoleAccess): string[] => sorted([...model.alwaysScopedBy, ...(access.scopedBy ?? [])])

function condition(model: PolicyModel, table: TablePolicy, access: RoleAccess): string {
  const keys = scopeKeys(model, access).map((key) => {
    const { setting, type } = model.keys[key] as PolicyKey
    return `${identifier(table.keyColumns[key], 'key column')} = NULLIF(current_setting('${setting}', true), '')::${type}`
  })
  const only = Object.entries(access.onlyValues ?? {})
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([column, values]) => `${identifier(column, 'column')}::text IN (${sorted(values).map((value) => `'${value}'`).join(', ')})`)
  return [...keys, ...only].join(' AND ')
}

function grants(table: TablePolicy, name: string, roleName: string, access: RoleAccess): string[] {
  const privileges = PRIVILEGES.filter((privilege) => access.privileges.includes(privilege))
  const hidden = new Set(access.hiddenColumns ?? [])
  if (hidden.size === 0) {
    return [`GRANT ${privileges.map((p) => p.toUpperCase()).join(', ')} ON TABLE ${name} TO ${role(roleName)};`]
  }
  const visible = sorted(table.columns.filter((column) => !hidden.has(column)))
    .map((column) => identifier(column, 'column'))
    .join(', ')
  const out: string[] = []
  const columnLevel = privileges.filter((privilege) => privilege !== 'delete')
  if (columnLevel.length > 0) {
    out.push(`GRANT ${columnLevel.map((p) => `${p.toUpperCase()} (${visible})`).join(', ')} ON TABLE ${name} TO ${role(roleName)};`)
  }
  if (privileges.includes('delete')) out.push(`GRANT DELETE ON TABLE ${name} TO ${role(roleName)};`)
  return out
}

function policies(model: PolicyModel, table: TablePolicy, name: string, roleName: string, access: RoleAccess): string[] {
  const check = `(${condition(model, table, access)})`
  return PRIVILEGES.filter((privilege) => access.privileges.includes(privilege)).map((privilege) => {
    const head = `CREATE POLICY ${identifier(`${roleName}_${privilege}`, 'policy')} ON ${name} AS PERMISSIVE FOR ${privilege.toUpperCase()} TO ${role(roleName)}`
    if (privilege === 'insert') return `${head} WITH CHECK ${check};`
    if (privilege === 'update') return `${head} USING ${check} WITH CHECK ${check};`
    return `${head} USING ${check};`
  })
}

function tableSql(model: PolicyModel, table: TablePolicy): string {
  const name = tableName(table)
  const schema = table.schema ?? 'public'
  const lines = [
    `-- ${name}`,
    `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;`,
    // Every policy on the table goes, also one this model did not make: permissive policies add up.
    `DO $$ DECLARE existing record; BEGIN FOR existing IN SELECT policyname FROM pg_policies WHERE schemaname = '${schema}' AND tablename = '${table.table}' LOOP EXECUTE format('DROP POLICY %I ON %I.%I', existing.policyname, '${schema}', '${table.table}'); END LOOP; END $$;`,
    `REVOKE ALL ON TABLE ${name} FROM PUBLIC, ${sorted(model.roles).map(role).join(', ')};`,
  ]
  const roles = sorted(Object.keys(table.access))
  for (const roleName of roles) lines.push(...grants(table, name, roleName, table.access[roleName] as RoleAccess))
  for (const roleName of roles) lines.push(...policies(model, table, name, roleName, table.access[roleName] as RoleAccess))
  return `${lines.join('\n')}\n`
}

const tableOrder = (a: TablePolicy, b: TablePolicy): number =>
  byCodePoint(a.schema ?? 'public', b.schema ?? 'public') || byCodePoint(a.table, b.table)

/** The SQL for every table of the model, plus USAGE on their schemas for every managed role. */
export function policySql(model: PolicyModel): string {
  checkModel(model)
  const schemas = sorted(model.tables.map((table) => table.schema ?? 'public'))
  const roles = sorted(model.roles).map(role).join(', ')
  const head = schemas.map((schema) => `GRANT USAGE ON SCHEMA ${identifier(schema, 'schema')} TO ${roles};\n`).join('')
  return head + [...model.tables].sort(tableOrder).map((table) => tableSql(model, table)).join('')
}

/** The SQL for ONE table of the model (for the migration that adds or changes it), the same bytes `policySql` has. */
export function tablePolicySql(model: PolicyModel, table: string, schema = 'public'): string {
  checkModel(model)
  const found = model.tables.find((entry) => entry.table === table && (entry.schema ?? 'public') === schema)
  if (!found) return fail(`The policy model has no table ${schema}.${table}.`)
  return tableSql(model, found)
}

/**
 * Creates each runtime role if it is missing (NOLOGIN, no administrative attribute) and refuses, by raising, a role of
 * that name that can log in or holds an administrative attribute. Idempotent; needs CREATEROLE.
 */
export function runtimeRoleSql(roles: readonly string[]): string {
  if (roles.length === 0) fail('runtimeRoleSql needs at least one role.')
  return sorted(roles)
    .map((name) => {
      const quoted = role(name)
      return [
        'DO $$ BEGIN',
        `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN`,
        `    CREATE ROLE ${quoted} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`,
        '  END IF;',
        `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN`,
        `    RAISE EXCEPTION 'Runtime role ${name} must be NOLOGIN and hold no administrative attribute';`,
        '  END IF;',
        'END $$;',
      ].join('\n')
    })
    .join('\n')
    .concat('\n')
}

/**
 * The database wall behind the statement guard: only the given logins may EXECUTE `set_config`, so SQL running as a
 * runtime role cannot change the scope even through a function that runs a query from a string. The adapter still
 * works: its scope statement is checked as the login, before the role switch takes effect. Grant it also to any other
 * non-superuser login that needs `set_config` (a restore or migration login). Needs the function's owner (a superuser).
 */
export function lockSetConfigSql(logins: readonly string[], runtimeRoles: readonly string[]): string {
  if (logins.length === 0) fail('lockSetConfigSql needs the login(s) the adapter connects as.')
  const fn = 'FUNCTION pg_catalog.set_config(text, text, boolean)'
  return [
    `REVOKE EXECUTE ON ${fn} FROM PUBLIC${runtimeRoles.length > 0 ? `, ${sorted(runtimeRoles).map(role).join(', ')}` : ''};`,
    `GRANT EXECUTE ON ${fn} TO ${sorted(logins).map(role).join(', ')};`,
  ]
    .join('\n')
    .concat('\n')
}

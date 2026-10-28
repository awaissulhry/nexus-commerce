import { Pool, type PoolClient, type PoolConfig } from 'pg'

/**
 * The runtime-login audit, ported from Commerce's `auditRuntimeRole` (packages/database/runtime-role.ts) with the role
 * names as parameters. It inspects the LOGIN (`session_user`), so a connection that already entered a runtime role
 * cannot hide a privileged login behind it, and every role the login can reach through memberships.
 *
 * It refuses a login that, itself or through any reachable role:
 *   - is a superuser, has BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION, or belongs to a predefined `pg_*` role;
 *   - owns the database, or may CREATE in it or in any application schema;
 *   - owns any schema, table, view, sequence, function or type in an application schema (owners skip RLS unless it is
 *     forced, and can change policies);
 *   - holds TRUNCATE, REFERENCES or TRIGGER on an application table (TRUNCATE ignores RLS);
 *   - holds a membership WITH ADMIN OPTION;
 * and it requires that the login can enter (SET) every runtime role, that each exists, and, when asked, the INHERIT
 * shape and a locked `set_config` (see `lockSetConfigSql`).
 */

export interface RuntimeRoleAudit {
  /** The roles the login must be able to enter with SET ROLE, e.g. the tenant, floor and partner runtime roles. */
  readonly roles: readonly string[]
  /**
   * true: the login must inherit every runtime role (queries that never SET ROLE still work, as in Commerce).
   * false: it must inherit none (a query that skips the adapter has no table access at all).
   * Omitted: not checked.
   */
  readonly inherit?: boolean
  /** true: no runtime role may EXECUTE `set_config` (the database wall behind the statement guard). */
  readonly setConfigLocked?: boolean
}

type Queryable = Pick<PoolClient, 'query'>

const CHECKS: readonly (readonly [column: string, failure: string])[] = [
  ['roles_exist', 'a runtime role does not exist'],
  ['roles_granted', 'the login is not a member of every runtime role'],
  ['no_admin_attributes', 'the login or a role it reaches is a superuser, has BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION, or is a pg_* role'],
  ['not_database_owner', 'the login or a role it reaches owns the database'],
  ['no_database_create', 'the login or a role it reaches may CREATE in the database'],
  ['no_admin_option', 'the login holds a role membership WITH ADMIN OPTION'],
  ['owns_no_schema', 'the login or a role it reaches owns an application schema'],
  ['owns_no_relation', 'the login or a role it reaches owns an application table, view or sequence'],
  ['owns_no_function', 'the login or a role it reaches owns an application function'],
  ['owns_no_type', 'the login or a role it reaches owns an application type'],
  ['no_table_bypass', 'the login or a role it reaches holds TRUNCATE, REFERENCES or TRIGGER on an application table'],
  ['no_schema_create', 'the login or a role it reaches may CREATE in an application schema'],
]

const AUDIT_SQL = `
  WITH RECURSIVE reachable AS (
    SELECT oid FROM pg_roles WHERE rolname = session_user
    UNION
    SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON m.member = r.oid
  ), roles AS (SELECT p.* FROM pg_roles p JOIN reachable r USING (oid)),
  app_schemas AS (
    SELECT * FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
  )
  SELECT
    (SELECT count(*) FROM pg_roles WHERE rolname = ANY ($1::text[])) = cardinality($1::text[]) AS roles_exist,
    (SELECT count(*) FROM roles WHERE rolname = ANY ($1::text[])) = cardinality($1::text[]) AS roles_granted,
    NOT EXISTS (SELECT 1 FROM roles WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
      OR starts_with(rolname, 'pg_')) AS no_admin_attributes,
    NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database()
      AND datdba IN (SELECT oid FROM reachable)) AS not_database_owner,
    NOT EXISTS (SELECT 1 FROM roles WHERE has_database_privilege(oid, current_database(), 'CREATE')) AS no_database_create,
    NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM reachable) AND admin_option) AS no_admin_option,
    NOT EXISTS (SELECT 1 FROM app_schemas WHERE nspowner IN (SELECT oid FROM reachable)) AS owns_no_schema,
    NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace IN (SELECT oid FROM app_schemas)
      AND relowner IN (SELECT oid FROM reachable)) AS owns_no_relation,
    NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN (SELECT oid FROM app_schemas)
      AND proowner IN (SELECT oid FROM reachable)) AS owns_no_function,
    NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace IN (SELECT oid FROM app_schemas)
      AND typowner IN (SELECT oid FROM reachable)) AS owns_no_type,
    NOT EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_class c
      WHERE c.relnamespace IN (SELECT oid FROM app_schemas) AND c.relkind IN ('r', 'p')
      AND has_table_privilege(r.oid, c.oid, 'TRUNCATE,REFERENCES,TRIGGER')) AS no_table_bypass,
    NOT EXISTS (SELECT 1 FROM roles r CROSS JOIN app_schemas n
      WHERE has_schema_privilege(r.oid, n.oid, 'CREATE')) AS no_schema_create
`

// pg_has_role(…, 'SET') and 'USAGE' read the membership options (PostgreSQL 16+). has_function_privilege follows
// inheritance, so a runtime role that reaches EXECUTE through another role counts as unlocked.
const ACCESS_SQL = `
  SELECT r AS role,
    pg_has_role(session_user, r, 'SET') AS enter,
    pg_has_role(session_user, r, 'USAGE') AS inherit,
    has_function_privilege(r, 'pg_catalog.set_config(text, text, boolean)', 'EXECUTE') AS set_config
  FROM unnest($1::text[]) AS r
`

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/

export class UnsafeRuntimeLoginError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`Unsafe database runtime login: ${failures.join('; ')}.`)
    this.name = 'UnsafeRuntimeLoginError'
  }
}

/** Throws `UnsafeRuntimeLoginError` listing every failed check; resolves when the login is safe. */
export async function auditRuntimeRole(client: Queryable, audit: RuntimeRoleAudit): Promise<void> {
  const roles = [...new Set(audit.roles)]
  if (roles.length === 0 || roles.some((role) => typeof role !== 'string' || !ROLE.test(role))) {
    throw new UnsafeRuntimeLoginError(['the audit names no runtime role, or a malformed one'])
  }
  const { rows } = await client.query<Record<string, boolean>>(AUDIT_SQL, [roles])
  const result = rows[0]
  const failures = CHECKS.filter(([column]) => result?.[column] !== true).map(([, failure]) => failure)
  // The access query needs every role to exist (pg_has_role raises otherwise).
  if (failures.length === 0) {
    const access = await client.query<{ role: string; enter: boolean; inherit: boolean; set_config: boolean }>(ACCESS_SQL, [roles])
    for (const row of access.rows) {
      if (row.enter !== true) failures.push(`the login cannot enter ${row.role}`)
      if (audit.inherit === true && row.inherit !== true) failures.push(`the login does not inherit ${row.role}: grant it WITH INHERIT TRUE`)
      if (audit.inherit === false && row.inherit === true) failures.push(`the login inherits ${row.role}: grant it WITH INHERIT FALSE`)
      if (audit.setConfigLocked === true && row.set_config === true) failures.push(`${row.role} may execute set_config`)
    }
  }
  if (failures.length > 0) throw new UnsafeRuntimeLoginError(failures)
}

type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, done: (release?: Error | boolean) => void) => void

/**
 * A pg Pool that audits each physical connection once, before pg or Prisma can borrow it (ported from Commerce's
 * `RuntimePool`, without its environment switch: whoever builds the pool decides). A connection that fails the audit is
 * destroyed and the borrow fails, in both the promise and the callback form, and so does `pool.query`.
 */
export class AuditedPool extends Pool {
  private readonly verified = new WeakSet<PoolClient>()

  constructor(
    config: PoolConfig,
    private readonly audit: RuntimeRoleAudit,
  ) {
    super(config)
  }

  override connect(): Promise<PoolClient>
  override connect(callback: ConnectCallback): void
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const connect = async (): Promise<PoolClient> => {
      const client = await super.connect()
      try {
        if (!this.verified.has(client)) {
          await auditRuntimeRole(client, this.audit)
          this.verified.add(client)
        }
        return client
      } catch (error) {
        client.release(true)
        throw error
      }
    }
    if (!callback) return connect()
    void connect().then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: Error) => callback(error, undefined, () => {}),
    )
  }
}

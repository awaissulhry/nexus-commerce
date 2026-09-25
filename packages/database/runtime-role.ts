import { Pool, type PoolClient } from 'pg'

/** Inspect the LOGIN identity, even if this connection is already SET ROLE'd. */
export async function auditRuntimeRole(client: Pick<PoolClient, 'query'>): Promise<void> {
  const { rows } = await client.query<{ safe: boolean }>(`
    WITH RECURSIVE reachable AS (
      SELECT oid FROM pg_roles WHERE rolname = session_user
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON m.member = r.oid
    ), roles AS (SELECT p.* FROM pg_roles p JOIN reachable r USING (oid)),
    app_schemas AS (
      SELECT * FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
    )
    SELECT
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime')
      AND EXISTS (SELECT 1 FROM roles WHERE rolname = 'nexus_workspace_runtime')
      AND NOT EXISTS (SELECT 1 FROM roles WHERE rolsuper OR rolbypassrls OR rolcreaterole
        OR rolcreatedb OR rolreplication OR rolname LIKE 'pg_%')
      AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database()
        AND datdba IN (SELECT oid FROM reachable))
      AND NOT EXISTS (SELECT 1 FROM roles WHERE has_database_privilege(oid, current_database(), 'CREATE'))
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM reachable) AND admin_option)
      AND NOT EXISTS (SELECT 1 FROM app_schemas WHERE nspowner IN (SELECT oid FROM reachable))
      AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace IN (SELECT oid FROM app_schemas)
        AND relowner IN (SELECT oid FROM reachable))
      AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN (SELECT oid FROM app_schemas)
        AND proowner IN (SELECT oid FROM reachable))
      AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace IN (SELECT oid FROM app_schemas)
        AND typowner IN (SELECT oid FROM reachable))
      AND NOT EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_class c
        WHERE c.relnamespace IN (SELECT oid FROM app_schemas) AND c.relkind IN ('r', 'p')
        AND has_table_privilege(r.oid, c.oid, 'TRUNCATE,REFERENCES,TRIGGER'))
      AND NOT EXISTS (SELECT 1 FROM roles r CROSS JOIN app_schemas n
        WHERE has_schema_privilege(r.oid, n.oid, 'CREATE'))
      AS safe
  `)
  if (rows[0]?.safe !== true) {
    throw new Error('Unsafe database runtime login: require restricted role membership, no administrative privileges, schema CREATE authority or application object ownership')
  }
  // Membership with SET FALSE is insufficient. pg_has_role checks whether the
  // session can actually enter the target role without mutating an open transaction.
  const access = await client.query<{ allowed: boolean }>(
    "SELECT pg_has_role(session_user, 'nexus_workspace_runtime', 'SET') AS allowed",
  )
  if (access.rows[0]?.allowed !== true) throw new Error('Database login cannot enter nexus_workspace_runtime')
}

type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, done: (error?: Error | boolean) => void) => void

/** Verify each physical connection before either pg or Prisma can borrow it. */
export class RuntimePool extends Pool {
  private readonly verified = new WeakSet<PoolClient>()

  override connect(): Promise<PoolClient>
  override connect(callback: ConnectCallback): void
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const connect = async () => {
      const client = await super.connect()
      try {
        if ((process.env.NODE_ENV === 'production' || process.env.NEXUS_ENFORCE_RUNTIME_ROLE === '1') && !this.verified.has(client)) {
          await auditRuntimeRole(client)
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
      client => callback(undefined, client, client.release.bind(client)),
      error => callback(error, undefined, () => {}),
    )
  }
}

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { LEGACY_WORKSPACE_ID, WorkspaceError, workspaceContext } from './workspace-context.js';
let resolver;
export function registerWorkspaceResolver(next) { resolver = next; }
export async function resolveWorkspaceContext() {
    return workspaceContext() ?? await resolver?.();
}
/**
 * The role and the business in ONE statement. `set_config('role', …, true)` is `SET LOCAL ROLE` (the same GUC and the
 * same membership check); `true` keeps all three settings local to the current transaction, so they end with it,
 * including when PgBouncer hands the connection to another client afterwards.
 */
const SCOPE_SQL = "SELECT set_config('role', 'nexus_workspace_runtime', true), set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)";
function scopeValues(scope) {
    return [scope?.workspaceId ?? (process.env.NEXUS_WORKSPACES_ENABLED === '1' ? '' : LEGACY_WORKSPACE_ID), scope?.actorUserId ?? ''];
}
async function configure(tx, scope) {
    const [workspaceId, actorId] = scopeValues(scope);
    const text = { scalarType: 'string', dbType: 'TEXT', arity: 'scalar' };
    await tx.queryRaw({ sql: SCOPE_SQL, args: [workspaceId, actorId], argTypes: [text, text] });
}
function prohibitScopeMutation(query) {
    // Only this adapter may alter the transaction's authority. User-supplied values remain
    // bound parameters; application raw SQL cannot replace the context or database role.
    // Deliberately conservative: application statements have no reason to change
    // session configuration. Cover parameterized set_config, comments and RESET ALL.
    const sql = query.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    if (/\bset_config\b|\bRESET\b|\bSET\s+(?:(?:LOCAL|SESSION)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION|nexus\b|row_security\b)|\bDISCARD\b/i.test(sql)) {
        throw new WorkspaceError('workspace_scope_immutable', 'Database workspace context cannot be changed by a query.');
    }
}
function wrapTransaction(tx) {
    return new Proxy(tx, {
        get(target, property) {
            if (property === 'queryRaw' || property === 'executeRaw')
                return async (query) => {
                    prohibitScopeMutation(query);
                    return target[property](query);
                };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
const BaseQuery = pg.Query;
// Exported by pg at runtime (`pg.utils`), not in its type declarations.
const prepareValue = pg.utils.prepareValue;
/**
 * One statement outside a transaction, in ONE round trip: the scope statement and the statement itself go to the server
 * as one extended-protocol batch with a single Sync. PostgreSQL runs everything before a Sync as one implicit
 * transaction, so the role and business set by the first statement hold for the second and end at the Sync — the same
 * boundary the explicit BEGIN … COMMIT gave, without its three extra round trips. If the scope statement fails, the
 * server skips the rest up to the Sync: the statement never runs unscoped.
 */
class ScopedQuery extends BaseQuery {
    scope;
    scopeAnswered = false;
    /** The server's transaction status after the Sync ('I' = idle). */
    transactionStatus;
    /** The statement failed with the server's own error: the batch ended at the Sync and the connection is sound. */
    serverRefused = false;
    constructor(scope, config, callback) {
        // Always the extended protocol: the simple protocol cannot carry the scope's bound values in the same batch.
        super({ ...config, queryMode: 'extended' }, undefined, callback);
        this.scope = scope;
    }
    submit(connection) {
        if (typeof this.text !== 'string' || this.name || this.rows)
            return new Error('A workspace-scoped statement needs query text, no statement name and no row limit.');
        if (this.values !== undefined && !Array.isArray(this.values))
            return new Error('Query values must be an array');
        // Serialise the values before anything is sent, so a value that cannot be sent fails here and never leaves an
        // unsynced batch on the connection (pg's own bind failure would). prepareValue is idempotent on its output.
        try {
            this.values = this.values?.map(value => prepareValue(value));
        }
        catch (error) {
            return error;
        }
        connection.once('readyForQuery', message => { this.transactionStatus = message.status; });
        connection.stream.cork?.();
        try {
            connection.parse({ text: SCOPE_SQL, name: '', types: [] });
            connection.bind({ portal: '', statement: '', values: this.scope });
            connection.execute({ portal: '', rows: 0 });
            return super.submit(connection);
        }
        finally {
            connection.stream.uncork?.();
        }
    }
    // The scope statement answers first with one row and its CommandComplete; neither belongs to the caller's result.
    handleDataRow(message) { if (this.scopeAnswered)
        super.handleDataRow(message); }
    handleCommandComplete(message, connection) {
        if (!this.scopeAnswered) {
            this.scopeAnswered = true;
            return;
        }
        super.handleCommandComplete(message, connection);
    }
    handleError(error, connection) {
        this.serverRefused = error instanceof pg.DatabaseError;
        super.handleError(error, connection);
    }
}
async function scopedStatement(pool, scope, run) {
    const connection = await pool.connect();
    // A connection error while checked out must not become an unhandled 'error' event; the statement's callback reports it.
    const onError = () => { };
    connection.on('error', onError);
    let last;
    let released = false;
    const release = (error) => {
        if (released)
            return;
        released = true;
        connection.removeListener('error', onError);
        connection.release(error);
    };
    try {
        const result = await run({
            query: config => new Promise((resolve, reject) => {
                last = new ScopedQuery(scope, config, (error, value) => error ? reject(error) : resolve(value));
                connection.query(last);
            }),
        });
        if (last && last.transactionStatus !== 'I') {
            // Tripwire: a statement that left a transaction open would hand its scope to the next borrower. Discard the
            // connection (the server rolls the transaction back) instead of returning it to the pool.
            release(new Error('A workspace-scoped statement left a transaction open.'));
            throw new WorkspaceError('workspace_scope_immutable', 'Database workspace context cannot be changed by a query.');
        }
        release();
        return result;
    }
    catch (error) {
        // The server's own refusal (a constraint, a policy, a bad value) ends the implicit transaction at the Sync, rolled
        // back: the connection is clean and goes back to the pool, as the ROLLBACK path did before. Anything else (a broken
        // socket, a read timeout, a refused submit) discards it.
        release(last?.serverRefused ? undefined : error instanceof Error ? error : new Error(String(error)));
        throw error;
    }
}
/** The same transaction boundary covers ORM queries, nested relations and raw SQL. */
export class WorkspacePg extends PrismaPg {
    pool;
    scope;
    constructor(pool, scope) {
        super(pool);
        this.pool = pool;
        this.scope = scope;
    }
    async connect() {
        const adapter = await super.connect();
        const captured = this.scope;
        const pool = this.pool;
        return new Proxy(adapter, {
            get(target, property) {
                if (property === 'startTransaction')
                    return async (isolation) => {
                        const tx = await target.startTransaction(isolation);
                        try {
                            await configure(tx, captured);
                            return wrapTransaction(tx);
                        }
                        catch (error) {
                            try {
                                await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] });
                            }
                            finally {
                                await tx.rollback();
                            }
                            throw error;
                        }
                    };
                if (property === 'queryRaw' || property === 'executeRaw')
                    return async (query) => {
                        prohibitScopeMutation(query);
                        // The pg adapter's own statement path (argument mapping, result types), over a checked-out connection whose
                        // every statement carries the scope. Only `client` differs from the adapter it reads through.
                        return scopedStatement(pool, scopeValues(captured), client => {
                            const view = Object.create(target, { client: { value: client } });
                            return view[property](query);
                        });
                    };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }
}

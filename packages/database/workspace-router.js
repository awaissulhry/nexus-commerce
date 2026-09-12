import { assertWorkspaceSql } from './workspace-sql.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { WorkspacePg, resolveWorkspaceContext } from './workspace-adapter.js';
import { scopedPrisma } from './workspace-client.js';
import { WorkspaceError, workspaceContext } from './workspace-context.js';
const modelNames = new Set(Prisma.dmmf.datamodel.models.map(model => model.name[0].toLowerCase() + model.name.slice(1)));
const sameScope = (a, b) => a?.workspaceId === b?.workspaceId && a?.actorUserId === b?.actorUserId;
function invoke(client, operation) {
    if (!operation.model)
        assertWorkspaceSql(operation.method, operation.args);
    const owner = operation.model ? Reflect.get(client, operation.model) : client;
    return Reflect.get(owner, operation.method).apply(owner, operation.args);
}
/** A query captures its scope when constructed, including when awaited by a later task. */
class ScopedOperation {
    operation;
    captured;
    execute;
    [Symbol.toStringTag] = 'PrismaPromise';
    promise;
    get executed() { return !!this.promise; }
    bindToTransaction(result) { this.promise = result; void result.catch(() => undefined); }
    constructor(operation, captured, execute) {
        this.operation = operation;
        this.captured = captured;
        this.execute = execute;
    }
    then(fulfilled, rejected) {
        return (this.promise ??= this.execute(this.operation, this.captured)).then(fulfilled, rejected);
    }
    catch(rejected) { return this.then(undefined, rejected); }
    finally(callback) { return (this.promise ??= this.execute(this.operation, this.captured)).finally(callback); }
}
function transactionProxy(tx, scope) {
    const delegates = new Map();
    const checked = (model, method) => (...args) => {
        const current = workspaceContext();
        if (current && !sameScope(current, scope))
            throw new WorkspaceError('workspace_transaction_changed', 'A transaction cannot change business profile.');
        return invoke(tx, { model, method, args });
    };
    return new Proxy(tx, {
        get(target, property) {
            if (typeof property !== 'string')
                return Reflect.get(target, property, target);
            if (modelNames.has(property)) {
                if (!delegates.has(property))
                    delegates.set(property, new Proxy({}, { get: (_owner, method) => typeof method === 'string' ? checked(property, method) : undefined }));
                return delegates.get(property);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? checked(null, property) : value;
        },
    });
}
/**
 * Fixed-context adapters bridge Prisma's execution resources without ambient mutable state.
 * Engines are bounded and share one pg pool. Evicting an idle engine does not close the pool.
 */
export function workspacePrisma(pool) {
    const clients = new Map();
    const delegates = new Map();
    const capacity = 32;
    const waiting = new Set();
    // Each bounded Prisma adapter installs one listener on the shared pg pool.
    if (pool.getMaxListeners() !== 0)
        pool.setMaxListeners(Math.max(pool.getMaxListeners(), capacity + 10));
    async function acquire(scope) {
        const key = JSON.stringify([scope?.workspaceId ?? '', scope?.actorUserId ?? '']);
        let entry = clients.get(key);
        while (!entry && clients.size >= capacity) {
            const idle = [...clients].filter(([, item]) => item.active === 0).sort((a, b) => a[1].used - b[1].used)[0];
            if (idle) {
                clients.delete(idle[0]);
                await idle[1].client.$disconnect();
            }
            else
                await new Promise(resolve => waiting.add(resolve));
            entry = clients.get(key);
        }
        if (!entry) {
            entry = { client: scopedPrisma(new PrismaClient({ adapter: new WorkspacePg(pool, scope), log: ['error'] }), scope), active: 0, used: Date.now() };
            clients.set(key, entry);
        }
        entry.active++;
        entry.used = Date.now();
        return { client: entry.client, release() {
                entry.active--;
                const pending = [...waiting];
                waiting.clear();
                for (const resume of pending)
                    resume();
            } };
    }
    const execute = async (operation, captured) => {
        const scope = captured ?? await resolveWorkspaceContext();
        const lease = await acquire(scope);
        try {
            return await invoke(lease.client, operation);
        }
        finally {
            lease.release();
        }
    };
    return new Proxy({}, {
        get(_target, property) {
            if (property === 'then')
                return undefined;
            if (property === '$disconnect')
                return async () => {
                    await Promise.all([...clients.values()].map(entry => entry.client.$disconnect()));
                    clients.clear();
                };
            if (property === '$transaction')
                return async (work, options) => {
                    const scope = workspaceContext() ?? await resolveWorkspaceContext();
                    const lease = await acquire(scope);
                    try {
                        if (typeof work === 'function') {
                            return await lease.client.$transaction(tx => work(transactionProxy(tx, scope)), options);
                        }
                        if (!Array.isArray(work) || new Set(work).size !== work.length || work.some(item => !(item instanceof ScopedOperation) || item.executed))
                            throw new WorkspaceError('invalid_transaction', 'Transactions require distinct, unexecuted database operations.', 400);
                        for (const item of work)
                            if (item.captured && !sameScope(item.captured, scope))
                                throw new WorkspaceError('workspace_transaction_changed', 'A transaction cannot include another business profile.');
                        const queries = work.map(item => invoke(lease.client, item.operation));
                        const result = lease.client.$transaction(queries, options);
                        work.forEach((item, index) => item.bindToTransaction(result.then(values => values[index])));
                        return await result;
                    }
                    finally {
                        lease.release();
                    }
                };
            if (typeof property !== 'string')
                return undefined;
            if (modelNames.has(property)) {
                if (!delegates.has(property))
                    delegates.set(property, new Proxy({}, {
                        get: (_owner, method) => typeof method === 'string' ? (...args) => new ScopedOperation({ model: property, method, args }, workspaceContext(), execute) : undefined,
                    }));
                return delegates.get(property);
            }
            return (...args) => new ScopedOperation({ model: null, method: property, args }, workspaceContext(), execute);
        },
    });
}

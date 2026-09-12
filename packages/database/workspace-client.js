import { Prisma } from '@prisma/client';
import keysJson from './workspaces/scoped-keys.json' with { type: 'json' };
import { LEGACY_WORKSPACE_ID, WorkspaceError } from './workspace-context.js';
const keys = keysJson;
const relationModels = Object.fromEntries(Prisma.dmmf.datamodel.models.map(model => [model.name,
    Object.fromEntries(model.fields.filter(field => field.kind === 'object').map(field => [field.name, field.type])),
]));
const singletonIds = Object.fromEntries(Prisma.dmmf.datamodel.models.flatMap(model => {
    const field = model.fields.find(field => field.isId && typeof field.default === 'string');
    return field ? [[model.name, field.default]] : [];
}));
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
function assertScope(value, workspaceId) {
    if (value !== undefined && value !== workspaceId)
        throw new WorkspaceError('workspace_mismatch', 'The record belongs to a different business profile.');
}
function singleton(model, id, workspaceId) {
    return id === singletonIds[model] && workspaceId !== LEGACY_WORKSPACE_ID ? `${workspaceId}:${id}` : id;
}
/** Preserve existing named compound selectors while making ownership mandatory. */
export function scopeUniqueWhere(model, source, workspaceId) {
    const definition = keys[model];
    if (!definition)
        return source;
    const where = { ...source };
    assertScope(where.workspaceId, workspaceId);
    for (const [field, alias] of Object.entries(definition.scalar)) {
        if (where[field] !== undefined && !record(where[field])) {
            where[alias] = { workspaceId, [field]: where[field] };
            delete where[field];
        }
        if (record(where[alias])) {
            assertScope(where[alias].workspaceId, workspaceId);
            where[alias] = { ...where[alias], workspaceId };
        }
    }
    for (const alias of Object.keys(definition.compound)) {
        if (record(where[alias])) {
            assertScope(where[alias].workspaceId, workspaceId);
            where[alias] = { ...where[alias], workspaceId };
        }
    }
    if (where.id !== undefined)
        where.id = singleton(model, where.id, workspaceId);
    return where;
}
function scopeData(model, value, workspaceId) {
    if (Array.isArray(value))
        return value.map(row => scopeData(model, row, workspaceId));
    if (!record(value))
        return value;
    const result = { ...value };
    if (keys[model]) {
        assertScope(result.workspaceId, workspaceId);
        if (result.id !== undefined)
            result.id = singleton(model, result.id, workspaceId);
        else if (singletonIds[model])
            result.id = singleton(model, singletonIds[model], workspaceId);
    }
    for (const [field, target] of Object.entries(relationModels[model] ?? {})) {
        const relation = result[field];
        if (!record(relation))
            continue;
        const nested = { ...relation };
        const map = (item, fn) => Array.isArray(item)
            ? item.map(row => record(row) ? fn(row) : row) : record(item) ? fn(item) : item;
        for (const operation of ['connect', 'set', 'disconnect', 'delete']) {
            if (nested[operation] !== undefined)
                nested[operation] = map(nested[operation], row => scopeUniqueWhere(target, row, workspaceId));
        }
        if (nested.create !== undefined)
            nested.create = scopeData(target, nested.create, workspaceId);
        if (record(nested.createMany))
            nested.createMany = { ...nested.createMany, data: scopeData(target, nested.createMany.data, workspaceId) };
        for (const operation of ['connectOrCreate', 'upsert', 'update']) {
            if (nested[operation] === undefined)
                continue;
            nested[operation] = map(nested[operation], row => {
                if (!('where' in row) && operation === 'update')
                    return scopeData(target, row, workspaceId);
                return scopeArguments(target, operation, row, workspaceId);
            });
        }
        if (nested.updateMany !== undefined)
            nested.updateMany = map(nested.updateMany, row => ({ ...row, data: scopeData(target, row.data, workspaceId) }));
        result[field] = nested;
    }
    return result;
}
export function scopeArguments(model, operation, input, workspaceId) {
    const args = { ...input };
    if (record(args.where) && ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert', 'connectOrCreate'].includes(operation)) {
        args.where = scopeUniqueWhere(model, args.where, workspaceId);
    }
    for (const field of ['data', 'create', 'update'])
        if (args[field] !== undefined)
            args[field] = scopeData(model, args[field], workspaceId);
    return args;
}
// Keep the driver boundary generic instead of expanding 400 generated delegate unions.
async function scopeOperation(raw, scope) {
    const { model, operation, args, query } = raw;
    const workspaceId = scope?.workspaceId ?? (process.env.NEXUS_WORKSPACES_ENABLED === '1' ? undefined : LEGACY_WORKSPACE_ID);
    if (!workspaceId && keys[model] && model !== 'AuditLog')
        throw new WorkspaceError('workspace_required', 'Select a business profile.', 400);
    return query(workspaceId ? scopeArguments(model, operation, args, workspaceId) : args);
}
export function scopedPrisma(client, scope) {
    return client.$extends({
        name: 'business-workspace-selectors',
        query: { $allModels: { $allOperations: (raw) => scopeOperation(raw, scope) } },
    });
}

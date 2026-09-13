import { AsyncLocalStorage } from 'node:async_hooks'

// Readiness producers may consume completed cache entries, never start provider work.
const cachedSchemas = new AsyncLocalStorage<boolean>()
export const cachedSchemasOnly = () => cachedSchemas.getStore() === true
export const withCachedSchemas = <T>(work: () => Promise<T>): Promise<T> => cachedSchemas.run(true, work)

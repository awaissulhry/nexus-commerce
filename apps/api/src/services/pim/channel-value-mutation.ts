import type { ChannelStore } from './channel-specs/types.js'
import { readStoredChannelValue, CHANNEL_OVERRIDE_COLUMNS } from './channel-inheritance.js'
import { readPath } from './sheet-values.js'
import { isManagedShopifyAttribute } from '../shopify/linked-state-guard.js'

export type ChannelValueAction = 'SET' | 'CLEAR' | 'INHERIT'
export type ValueRecord = Record<string, unknown>
export const jsonRecord = (value: unknown): ValueRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ValueRecord : {}
const clone = (value: unknown): ValueRecord => JSON.parse(JSON.stringify(jsonRecord(value)))

/** Import previews and the editor use the same presence/follow rules, including explicit blanks. */
export function storedChannelState(listing: ValueRecord, store: ChannelStore | undefined, keys: string[]) {
  const value = readStoredChannelValue(store, listing, keys)
  if (value === undefined) return { state: 'inherited' as const, value: null }
  const unitPath = store?.kind === 'platformAttributes' ? store.unitPath : undefined
  return { state: 'stored' as const, value: unitPath && value !== null
    ? { value, unit: readPath(listing.platformAttributes, unitPath) ?? null } : value }
}

export interface ChannelValueMutation {
  columns: ValueRecord
  overrideSet: ValueRecord
  overrideRemove: string[]
  platform: Array<{ path: string[]; value: unknown; remove: boolean }>
}

const assertKey = (key: string) => {
  if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid channel storage key')
}

/** One field's write rules. Persistence can apply these deltas atomically without replacing a JSON bag. */
export function channelValueMutation(store: ChannelStore | undefined, keys: string[], action: ChannelValueAction, incoming?: unknown): ChannelValueMutation {
  keys.forEach(assertKey)
  if (!keys.length) throw new Error('A channel override needs a field key')
  const inherit = action === 'INHERIT'
  const value = action === 'SET' ? incoming ?? null : null
  const mutation: ChannelValueMutation = { columns: {}, overrideSet: {}, overrideRemove: [...new Set(keys)], platform: [] }
  if (store?.kind === 'listingColumn') {
    assertKey(store.column)
    if (store.column === 'platformAttributes' || store.followFlag === 'platformAttributes') throw new Error('Use a validated platform-attribute path instead of replacing the listing attributes.')
    if (store.column === 'bulletPointsOverride') {
      if (value !== null && (!Array.isArray(value) || value.some(item => item !== null && typeof item === 'object'))) {
        throw new Error('Bullet points require a list of simple values')
      }
      // Prisma's String[] cannot hold null. Keep empty positions instead of shifting siblings.
      mutation.columns[store.column] = value === null ? [] : (value as unknown[]).map(item => item == null ? '' : String(item).trim())
    } else mutation.columns[store.column] = value
    const override = CHANNEL_OVERRIDE_COLUMNS[store.column]
    if (override) mutation.columns[override] = value
    if (store.followFlag) { assertKey(store.followFlag); mutation.columns[store.followFlag] = inherit }
  } else if (store?.kind === 'platformAttributes') {
    if (store.path[0] === '_etsyInformationLocales') mutation.overrideRemove = []
    const measure = store.unitPath && value !== null ? jsonRecord(value) : null
    mutation.platform.push({ path: store.path, value: measure ? measure.value ?? null : value, remove: inherit })
    if (store.unitPath) mutation.platform.push({ path: store.unitPath, value: measure?.unit ?? null, remove: inherit })
    for (const path of store.legacyPaths ?? []) mutation.platform.push({ path, value: null, remove: true })
    for (const { path } of mutation.platform) {
      if (!path.length) throw new Error('Invalid channel storage path')
      if (isManagedShopifyAttribute(path[0])) throw new Error('Use the Shopify family workspace to change managed family state.')
      path.forEach(assertKey)
    }
  } else if (!inherit) {
    mutation.overrideSet[keys[0]] = value
    mutation.overrideRemove = mutation.overrideRemove.filter(key => key !== keys[0])
  }
  return mutation
}

export function applyPlatformMutations(value: unknown, mutations: ChannelValueMutation['platform']): ValueRecord {
  const bag = clone(value)
  for (const { path, value, remove } of mutations) {
    if (!path.length) throw new Error('Invalid channel storage path')
    if (isManagedShopifyAttribute(path[0])) throw new Error('Use the Shopify family workspace to change managed family state.')
    path.forEach(assertKey)
    let current = bag
    let absent = false
    for (const part of path.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
        if (remove) { absent = true; break }
        current[part] = {}
      }
      current = current[part] as ValueRecord
    }
    if (absent) continue
    if (remove) delete current[path[path.length - 1]]
    else current[path[path.length - 1]] = value
  }
  return bag
}

/** Materialize the same deltas for an import preview guarded by its listing snapshot on apply. */
export function channelValuePatch(listing: ValueRecord, store: ChannelStore | undefined, keys: string[], action: ChannelValueAction, incoming?: unknown): ValueRecord {
  const mutation = channelValueMutation(store, keys, action, incoming)
  const bag = { ...clone(listing.overrideData), ...mutation.overrideSet }
  for (const key of mutation.overrideRemove) delete bag[key]
  return { ...mutation.columns, overrideData: bag,
    ...(mutation.platform.length ? { platformAttributes: applyPlatformMutations(listing.platformAttributes, mutation.platform) } : {}) }
}

import { getBackendUrl } from '@/lib/backend-url'
import type { CategoryMappingRow } from '@/app/channels/mapping/_shared/contracts'

export interface CategoryRow { id: string; parentId: string | null; name: string; path: string; slug: string; code: string | null; active: boolean; products: number; children: number; mappings: number }
export interface Directory { rows: CategoryRow[]; token: string }
export interface Source {
  channel: string; market: string; name: string; label: string; kind: 'categories' | 'productTypes'; supported: boolean; requirements: 'category' | 'store' | null;
  sourceId: string | null; snapshotId: string | null; nodeCount: number | null; state: string; error: string | null;
  changes: { added: number; removed: number; changed: number } | null; lastSyncedAt: string | null; nextSyncAt: string | null;
  accounts: { id: string; name: string }[];
}
export interface Node { externalId: string; parentId: string | null; name: string; path: string; assignable: boolean; metadata?: Record<string, unknown> }
export interface NodeResults { items: Node[]; total: number; page: number; pages: number; snapshotId: string | null; state: string }
export interface Requirements { node: Node; snapshotId: string; state: string; schema: { id: string; version: string; definition: Record<string, unknown>; fetchedAt: string; expiresAt: string } | null }
export type AssignmentRow = CategoryMappingRow & { health: string; currentPath: string | null }
export interface Assignments { rows: AssignmentRow[]; counts: { total: number; mapped: number; inherited: number }; token: string }
export interface CategoryCommand { action: 'create' | 'rename' | 'move' | 'delete'; id?: string; name?: string; slug?: string; code?: string; parentId?: string | null; expectedToken: string }
export interface ChangeImpact { productCount: number; descendantCount: number; inheritedChanges: string[]; blocked: string | null; token: string }
export interface ImportRun { id: string; status: string; providerVersion: string | null; nodeCount: number; addedCount: number; removedCount: number; changedCount: number; error: string | null; createdAt: string; completedAt: string | null }

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/pim/${path}`, { credentials: 'include', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? 'The request could not complete. Try again.')
  if (!body || typeof body !== 'object') throw new Error('The server returned an incomplete response. Try again.')
  return body as T
}
export const scopePath = (source: Pick<Source, 'channel' | 'market'>) => `${encodeURIComponent(source.channel)}/${encodeURIComponent(source.market)}`
export const refreshSource = (source: Source, categoryId?: string) => request(`taxonomies/${scopePath(source)}/refresh`, { method: 'POST', ...(categoryId ? { body: JSON.stringify({ categoryId }) } : {}) })
export const categoryCommand = <T>(operation: 'preview' | 'apply', command: CategoryCommand) => request<T>(`category-workspace/${operation}`, { method: 'POST', body: JSON.stringify(command) })
export const categoryHref = (view: string, source?: Pick<Source, 'channel' | 'market'>) => `/catalog/categories?${new URLSearchParams({ view, ...(source ? { channel: source.channel, market: source.market } : {}) })}`

export function requirementFields(requirements: Requirements): { key: string; label: string; required: boolean }[] {
  const definition = requirements.schema?.definition
  if (Array.isArray(definition?.aspects)) return definition.aspects.map((v: any) => ({ key: v.id, label: v.label ?? v.localizedName ?? v.id, required: v.required === true }))
  if (Array.isArray(definition?.results)) return definition.results.map((v: any) => ({ key: String(v.property_id), label: v.display_name ?? v.name ?? String(v.property_id), required: v.is_required === true }))
  if (definition?.properties && typeof definition.properties === 'object') return Object.entries(definition.properties).filter(([key]) => !key.startsWith('__')).map(([key, value]) => ({ key, label: (value as { title?: string })?.title ?? key, required: Array.isArray(definition.required) && definition.required.includes(key) }))
  const attributes = requirements.node.metadata?.attributes
  return Array.isArray(attributes) ? attributes.map((v: any) => ({ key: String(v.id), label: v.name ?? String(v.id), required: false })) : []
}

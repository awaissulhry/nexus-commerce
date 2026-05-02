'use client'

const STORAGE_KEY = 'nexus_bulkops_views_v1'

export interface SavedView {
  id: string
  name: string
  columnIds: string[]
  channels?: string[]
  productTypes?: string[]
  isDefault?: boolean
  createdAt: number
}

export const DEFAULT_VIEWS: ReadonlyArray<SavedView> = [
  {
    id: 'default',
    name: 'Default',
    columnIds: [
      'sku',
      'name',
      'brand',
      'status',
      'fulfillmentChannel',
      'basePrice',
      'costPrice',
      'totalStock',
      'amazonAsin',
    ],
    isDefault: true,
    createdAt: 0,
  },
  {
    id: 'pricing',
    name: 'Pricing Focus',
    columnIds: [
      'sku',
      'name',
      'costPrice',
      'minMargin',
      'minPrice',
      'basePrice',
      'maxPrice',
      'totalStock',
    ],
    createdAt: 0,
  },
  {
    id: 'inventory',
    name: 'Inventory Quick',
    columnIds: [
      'sku',
      'name',
      'totalStock',
      'lowStockThreshold',
      'fulfillmentChannel',
      'status',
    ],
    createdAt: 0,
  },
]

function readUserViews(): SavedView[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeUserViews(views: SavedView[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views))
    window.dispatchEvent(new CustomEvent('nexus:views-changed'))
  } catch {
    /* swallow quota errors */
  }
}

export function loadAllViews(): SavedView[] {
  return [...DEFAULT_VIEWS, ...readUserViews()]
}

export function saveUserView(view: Omit<SavedView, 'createdAt'>): SavedView {
  const stored = readUserViews().filter((v) => v.id !== view.id)
  const full: SavedView = { ...view, createdAt: Date.now() }
  stored.push(full)
  writeUserViews(stored)
  return full
}

export function deleteUserView(id: string) {
  const stored = readUserViews().filter((v) => v.id !== id)
  writeUserViews(stored)
}

export function isDefaultView(id: string): boolean {
  return DEFAULT_VIEWS.some((v) => v.id === id)
}

export function getActiveViewId(): string {
  if (typeof window === 'undefined') return DEFAULT_VIEWS[0].id
  return window.localStorage.getItem('nexus_bulkops_active_view') ?? DEFAULT_VIEWS[0].id
}

export function setActiveViewId(id: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('nexus_bulkops_active_view', id)
}

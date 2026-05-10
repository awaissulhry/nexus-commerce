// MC.2.4 — saved views.
//
// localStorage-backed for now. The shape mirrors the dimensions the
// /assets/library API understands (search + FilterState) so when MC.2
// promotes this to a SavedView Prisma model the migration is a flat
// translation: each row = the same object shape with workspace +
// owner + sharedWith columns added.
//
// Per-key storage: a JSON-serialised array with id + name + payload +
// createdAt. ID is a cuid-ish so two operators with the same view
// name don't collide if MC.2.4-follow-up shares them across the
// workspace.

import type { FilterState } from '../_components/FilterSidebar'

const KEY = 'nexus:marketing-content:saved-views'
const MAX = 24

export interface SavedView {
  id: string
  name: string
  search: string
  filter: FilterState
  createdAt: string
}

export interface SavedViewPayload {
  search: string
  filter: FilterState
}

function readRaw(): SavedView[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive: only keep rows whose shape matches.
    return parsed
      .filter(
        (v): v is SavedView =>
          typeof v === 'object' &&
          v !== null &&
          typeof v.id === 'string' &&
          typeof v.name === 'string' &&
          typeof v.search === 'string' &&
          typeof v.createdAt === 'string' &&
          typeof v.filter === 'object' &&
          v.filter !== null,
      )
      .slice(0, MAX)
  } catch {
    return []
  }
}

function writeRaw(views: SavedView[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(views.slice(0, MAX)))
  } catch {
    /* localStorage full or disabled — silent */
  }
}

export function listSavedViews(): SavedView[] {
  return readRaw().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function createSavedView(
  name: string,
  payload: SavedViewPayload,
): SavedView {
  const view: SavedView = {
    id: `sv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    search: payload.search,
    filter: payload.filter,
    createdAt: new Date().toISOString(),
  }
  const next = [view, ...readRaw().filter((v) => v.name !== view.name)].slice(
    0,
    MAX,
  )
  writeRaw(next)
  return view
}

export function deleteSavedView(id: string) {
  writeRaw(readRaw().filter((v) => v.id !== id))
}

export function renameSavedView(id: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  writeRaw(
    readRaw().map((v) => (v.id === id ? { ...v, name: trimmed } : v)),
  )
}

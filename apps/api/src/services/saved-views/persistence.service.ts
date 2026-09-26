import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

const LEGACY_OWNER = 'default-user'
const WORKING_NAME = 'Current layout'
const isSheetSurface = (surface: string) => /^product-edit:(views|layout):/.test(surface)
const isProductsGridSurface = (surface: string) => surface === 'products-next' || surface === 'products-next:layout'
const isWorkingSurface = (surface: string) => surface.startsWith('product-edit:layout:') || surface === 'products-next:layout'
/** SHEET-VIEWS P2 — only a product sheet's NAMED views can be shared or be a product type's default. */
const isSheetViewsSurface = (surface: string) => surface.startsWith('product-edit:views:')

export class SavedViewError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** Match the global RBAC rollout: only shadow mode permits an anonymous operator. */
export function savedViewOwner(request: object): string {
  const user = (request as { authUser?: { id: string } }).authUser
  if (user?.id) return user.id
  if (process.env.NEXUS_RBAC_MODE !== 'enforce') return LEGACY_OWNER
  throw new SavedViewError('Authentication required', 401)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 5000 && value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 500) && new Set(value).size === value.length
}

const VIEW_DENSITIES = new Set(['compact', 'cozy', 'spacious'])

/**
 * 2026-09-26 — the optional display fields a sheet view may carry beside its columns (web
 * `design-system/grid/views/viewPayload.ts` → `ViewDisplay`): widths, sort and row height. Absent is
 * valid and means "leave that alone"; present must be exactly the documented shape, because the client
 * applies what it reads to the grid.
 */
function validateViewDisplay(value: Record<string, unknown>): void {
  const widths = value.columnWidths
  if (widths !== undefined && (!record(widths) || Object.keys(widths).length > 5000 || Object.entries(widths).some(([key, px]) =>
    !key || key.length > 500 || typeof px !== 'number' || !Number.isFinite(px) || px < 20 || px > 2000))) {
    throw new SavedViewError('Column widths must map each column to a width between 20 and 2000 pixels')
  }
  const sort = value.sort
  if (sort !== undefined) {
    const entries = Array.isArray(sort) ? sort : null
    const valid = !!entries && entries.length <= 50 && entries.every((entry) =>
      record(entry) && typeof entry.colId === 'string' && entry.colId.length > 0 && entry.colId.length <= 500 && (entry.sort === 'asc' || entry.sort === 'desc'))
    if (!valid || new Set(entries!.map((entry) => (entry as { colId: string }).colId)).size !== entries!.length) {
      throw new SavedViewError('A view sort must list up to 50 distinct columns, each asc or desc')
    }
  }
  if (value.density !== undefined && (typeof value.density !== 'string' || !VIEW_DENSITIES.has(value.density))) {
    throw new SavedViewError('Row height must be compact, cozy or spacious')
  }
}

/**
 * SHEET-VIEWS step 5 (2026-09-26) — what a sheet view FOLLOWS besides its keys (web
 * `design-system/grid/views/viewRules.ts`): a group, the required fields, the fields with gaps. Optional;
 * present must be a short list of known rules, each once, because the client resolves it into columns.
 */
const VIEW_RULE_KINDS = new Set(['group', 'required', 'gaps'])
function validateViewRules(value: Record<string, unknown>): void {
  const rules = value.rules
  if (rules === undefined) return
  const ids = Array.isArray(rules) && rules.length <= 200 && rules.every((rule) =>
    record(rule) && typeof rule.kind === 'string' && VIEW_RULE_KINDS.has(rule.kind) &&
    (rule.kind === 'group' ? typeof rule.group === 'string' && rule.group.trim().length > 0 && rule.group.length <= 500 : rule.group === undefined))
    ? (rules as Array<{ kind: string; group?: string }>).map((rule) => `${rule.kind}:${rule.group ?? ''}`)
    : null
  if (!ids || new Set(ids).size !== ids.length) {
    throw new SavedViewError('View rules must be up to 200 distinct group, required or gaps rules')
  }
}

function validateColumnsPayload(value: unknown, allowLegacyGridState: boolean): void {
  if (!record(value)) throw new SavedViewError('A sheet view needs a valid columns payload')
  // Retain older named views; they are upgraded by the client when explicitly saved.
  if (allowLegacyGridState && value.v === 1 && record(value.gridState)) return
  const common = value.kind === 'columns' && keys(value.columns) && (value.chip === undefined || value.chip === null || typeof value.chip === 'string')
  if (value.v === 2 && common) {
    validateViewRules(value)
    return validateViewDisplay(value)
  }
  if (value.v !== 3 || !common || !keys(value.columnOrder) || !keys(value.lockedColumns) || !keys(value.groupOrder) || !record(value.groupOverrides)) {
    throw new SavedViewError('A sheet layout needs columns, columnOrder, lockedColumns, groupOrder and groupOverrides')
  }
  if (Object.entries(value.groupOverrides).length > 5000 || Object.entries(value.groupOverrides).some(([key, group]) => !key || key.length > 500 || typeof group !== 'string' || !group || group.length > 500)) {
    throw new SavedViewError('Every group override must identify a column and a group')
  }
  const ordered = new Set(value.columnOrder)
  if (!(value.columns as string[]).every((key) => ordered.has(key)) || !value.lockedColumns.every((key) => ordered.has(key))) {
    throw new SavedViewError('The column order must include every visible and locked column')
  }
  validateViewRules(value)
  validateViewDisplay(value)
}

/** Generic catalog filters stay opaque. The product grids own these versioned layout contracts. */
export function validateSavedViewPayload(surface: string, value: unknown): void {
  if (isProductsGridSurface(surface)) {
    if (!record(value) || value.v !== 1 || !record(value.gridState) || !record(value.page)) {
      throw new SavedViewError('A products grid view needs schema 1 with gridState and page objects')
    }
    const layout = value.page.columnLayout
    // Existing named views still restore their grid/page state; explicit saves add column metadata.
    if (layout === undefined && surface === 'products-next') return
    if (!record(layout) || layout.v !== 3) throw new SavedViewError('The products layout needs schema 3 columnLayout metadata')
    validateColumnsPayload(layout, false)
    return
  }
  if (isSheetSurface(surface)) validateColumnsPayload(value, !isWorkingSurface(surface))
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new SavedViewError('name required')
  return value.trim()
}

function surfaceOf(value: unknown): string {
  if (value === undefined) return 'products'
  if (typeof value !== 'string' || !value.trim() || value.length > 250) throw new SavedViewError('Invalid view surface')
  return value
}

function expectation(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new SavedViewError('Invalid expectedUpdatedAt')
  return new Date(value)
}

const stale = () => new SavedViewError('This view changed in another session. Reload the saved layout before saving again.', 409)

export interface WorkingLayoutInput {
  surface: string
  filters: unknown
  expectedUpdatedAt?: string | null
}

export interface SavedViewWriteInput {
  name?: unknown
  surface?: unknown
  filters?: unknown
  isDefault?: unknown
  /** SHEET-VIEWS P2 — the owner shares the view with the business. */
  shared?: unknown
  /** SHEET-VIEWS P2 — the product types this view opens by default for. */
  defaultProductTypes?: unknown
  expectedUpdatedAt?: unknown
  workingLayout?: WorkingLayoutInput
}

type Tx = Prisma.TransactionClient

/** Monotonic milliseconds make a returned timestamp usable as the next conditional-write token. */
function nextTimestamp(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}

async function saveWorking(tx: Tx, userId: string, input: unknown) {
  if (!record(input)) throw new SavedViewError('Invalid working layout')
  const surface = surfaceOf(input.surface)
  if (!isWorkingSurface(surface)) throw new SavedViewError('A working layout needs a supported layout surface')
  validateSavedViewPayload(surface, input.filters)
  const expected = expectation(input.expectedUpdatedAt)
  const current = await tx.savedView.findFirst({ where: { userId, surface, name: WORKING_NAME } })
  if (!current) {
    if (expected) throw stale()
    return tx.savedView.create({ data: { userId, surface, name: WORKING_NAME, filters: input.filters as Prisma.InputJsonValue, isDefault: false } })
  }
  if (!expected || expected.getTime() !== current.updatedAt.getTime()) throw stale()
  const changed = await tx.savedView.updateMany({
    where: { id: current.id, userId, updatedAt: expected },
    data: { filters: input.filters as Prisma.InputJsonValue, updatedAt: nextTimestamp(current.updatedAt) },
  })
  if (changed.count !== 1) throw stale()
  return tx.savedView.findUniqueOrThrow({ where: { id: current.id } })
}

function productTypesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || !value.every((type) => typeof type === 'string' && type.trim().length > 0 && type.length <= 100)) {
    throw new SavedViewError('defaultProductTypes must be a list of up to 50 product types')
  }
  return [...new Set(value.map((type: string) => type.trim().toUpperCase()))]
}

/** A teammate's name for a shared view — the profile's display name only, never an email. */
async function ownerNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const profiles = await prisma.userProfile.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })
  return new Map(profiles.filter((p) => p.displayName.trim()).map((p) => [p.id, p.displayName.trim()]))
}

export async function listSavedViews(userId: string, surface: string) {
  surface = surfaceOf(surface)
  const own = userId === LEGACY_OWNER || isWorkingSurface(surface) ? userId : { in: [userId, LEGACY_OWNER] }
  const rows = await prisma.savedView.findMany({
    // SHEET-VIEWS P2 — a teammate's SHARED view is listed too (row-level security keeps it inside the business).
    where: isSheetViewsSurface(surface) && userId !== LEGACY_OWNER ? { surface, OR: [{ userId: own }, { shared: true }] } : { userId: own, surface },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
  const ownedNames = new Set(rows.filter((row) => row.userId === userId).map((row) => row.name))
  const ownDefault = rows.some((row) => row.userId === userId && row.isDefault)
  const names = await ownerNames([...new Set(rows.filter((row) => row.userId !== userId && row.userId !== LEGACY_OWNER).map((row) => row.userId))])
  // A legacy template with the name of one of mine was replaced by my copy; a teammate's view never is.
  return rows.filter((row) => row.userId === userId || row.userId !== LEGACY_OWNER || !ownedNames.has(row.name)).map((row) => {
    const owned = row.userId === userId
    const legacy = !owned && row.userId === LEGACY_OWNER
    return {
      ...row,
      // Older shared templates remain discoverable; a personal default always wins. A teammate's own
      // default is theirs — it never becomes mine.
      isDefault: row.isDefault && (owned || (legacy && !ownDefault)),
      legacyShared: legacy,
      owned,
      teamShared: !owned && !legacy && row.shared,
      sharedBy: !owned && !legacy ? names.get(row.userId) ?? null : null,
    }
  })
}

/** One transaction for the view, default flag, and optional current-layout companion. */
export async function writeSavedView(userId: string, id: string | null, input: SavedViewWriteInput) {
  if (!record(input)) throw new SavedViewError('Invalid view')
  if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean') throw new SavedViewError('isDefault must be a boolean')
  const expected = expectation(input.expectedUpdatedAt)
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = id ? await tx.savedView.findFirst({ where: { id, userId: userId === LEGACY_OWNER ? userId : { in: [userId, LEGACY_OWNER] } } }) : null
      if (id && (!existing || (isWorkingSurface(existing.surface) && existing.userId !== userId))) throw new SavedViewError('View not found', 404)
      const surface = existing?.surface ?? surfaceOf(input.surface)
      if (input.workingLayout !== undefined) {
        const companion = input.workingLayout
        const layoutPrefix = surface.replace('product-edit:views:', 'product-edit:layout:')
        const sameScope = record(companion) && typeof companion.surface === 'string' && (surface === 'products-next'
          ? companion.surface === 'products-next:layout'
          : surface.startsWith('product-edit:views:') && (companion.surface === layoutPrefix || companion.surface.startsWith(`${layoutPrefix}:`)))
        if (!sameScope) {
          throw new SavedViewError('The working layout must belong to the same grid scope as the named view')
        }
      }
      if (existing && (isSheetSurface(surface) || isProductsGridSurface(surface)) && !expected) throw new SavedViewError('expectedUpdatedAt required to update this saved view')
      if (existing && expected && expected.getTime() !== existing.updatedAt.getTime()) throw stale()
      if (!existing && expected) throw stale()
      const name = input.name === undefined && existing ? existing.name : nameOf(input.name)
      if (isWorkingSurface(surface) && name !== WORKING_NAME) throw new SavedViewError('The working layout must be named Current layout')
      const filters = input.filters === undefined ? existing?.filters ?? {} : input.filters
      validateSavedViewPayload(surface, filters)
      const isDefault = isWorkingSurface(surface) ? false : (input.isDefault as boolean | undefined) ?? existing?.isDefault ?? false
      const owned = existing?.userId === userId
      /* SHEET-VIEWS P2 — sharing and product-type defaults: a sheet's named views only, and only the
         owner's (a legacy template edited here becomes the editor's own copy first, as before). */
      if ((input.shared !== undefined || input.defaultProductTypes !== undefined) && !isSheetViewsSurface(surface)) {
        throw new SavedViewError('Only a product sheet view can be shared or be a product type default')
      }
      if (input.shared !== undefined && typeof input.shared !== 'boolean') throw new SavedViewError('shared must be a boolean')
      const shared = (input.shared as boolean | undefined) ?? (owned ? existing!.shared ?? false : false)
      const defaultProductTypes = input.defaultProductTypes !== undefined ? productTypesOf(input.defaultProductTypes) : owned ? existing!.defaultProductTypes ?? [] : []
      if (defaultProductTypes.length) {
        // One default per (owner, surface, product type): taking a type moves it off my other views.
        const holders = await tx.savedView.findMany({ where: { userId, surface, defaultProductTypes: { hasSome: defaultProductTypes }, ...(owned ? { id: { not: existing!.id } } : {}) } })
        for (const previous of holders) {
          const changed = await tx.savedView.updateMany({
            where: { id: previous.id, userId, updatedAt: previous.updatedAt },
            data: { defaultProductTypes: (previous.defaultProductTypes ?? []).filter((type) => !defaultProductTypes.includes(type)), updatedAt: nextTimestamp(previous.updatedAt) },
          })
          if (changed.count !== 1) throw stale()
        }
      }
      if (isDefault) {
        const defaults = await tx.savedView.findMany({ where: { userId, surface, isDefault: true, ...(owned ? { id: { not: existing!.id } } : {}) } })
        for (const previous of defaults) {
          const changed = await tx.savedView.updateMany({
            where: { id: previous.id, userId, updatedAt: previous.updatedAt },
            data: { isDefault: false, updatedAt: nextTimestamp(previous.updatedAt) },
          })
          if (changed.count !== 1) throw stale()
        }
      }
      let saved
      if (existing && owned) {
        const changed = await tx.savedView.updateMany({
          where: { id: existing.id, userId, ...(expected ? { updatedAt: expected } : {}) },
          data: { name, filters: filters as Prisma.InputJsonValue, isDefault, shared, defaultProductTypes, updatedAt: nextTimestamp(existing.updatedAt) },
        })
        if (changed.count !== 1) throw stale()
        saved = await tx.savedView.findUniqueOrThrow({ where: { id: existing.id } })
      } else {
        // Editing a legacy shared view makes an owned copy; never take it away from other users.
        saved = await tx.savedView.create({ data: { userId, surface, name, filters: filters as Prisma.InputJsonValue, isDefault, shared, defaultProductTypes } })
      }
      const workingLayout = input.workingLayout === undefined ? undefined : await saveWorking(tx, userId, input.workingLayout)
      return { ...saved, legacyShared: false, owned: true, teamShared: false, sharedBy: null, ...(workingLayout ? { workingLayout } : {}) }
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'P2002') {
      if (typeof input.surface === 'string' && isWorkingSurface(input.surface)) throw new SavedViewError('This layout was saved in another session. Reload the saved layout before saving again.', 409)
      throw new SavedViewError('A view with this name already exists. Reload it or save a copy.', 409)
    }
    if (code === 'P2034') throw stale()
    throw error
  }
}

export async function deleteSavedView(userId: string, id: string): Promise<void> {
  const existing = await prisma.savedView.findFirst({ where: { id } })
  if (!existing || (existing.userId !== userId && existing.userId !== LEGACY_OWNER)) throw new SavedViewError('View not found', 404)
  if (existing.userId !== userId) throw new SavedViewError('Shared legacy views cannot be deleted. Save a personal copy to manage it.', 403)
  await prisma.savedView.deleteMany({ where: { id, userId } })
}

/** Alert summaries share the same owner-filtered view list as the saved-view picker. */
export async function listSavedViewsWithAlerts(userId: string, surface: string) {
  const views = await listSavedViews(userId, surface)
  const alerts = views.length ? await prisma.savedViewAlert.findMany({
    where: { savedViewId: { in: views.map((view) => view.id) } },
    select: { savedViewId: true, isActive: true, lastFiredAt: true },
  }) : []
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const summaries = new Map<string, { active: number; total: number; firedRecently: number }>()
  for (const alert of alerts) {
    const summary = summaries.get(alert.savedViewId) ?? { active: 0, total: 0, firedRecently: 0 }
    summary.total++
    if (alert.isActive) summary.active++
    if (alert.lastFiredAt && alert.lastFiredAt >= since24h) summary.firedRecently++
    summaries.set(alert.savedViewId, summary)
  }
  return views.map((view) => ({ ...view, alertSummary: summaries.get(view.id) ?? { active: 0, total: 0, firedRecently: 0 } }))
}

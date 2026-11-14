import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { layoutKey, layoutOf, layoutProblems, type Board, type LayoutPanel, type PanelWidth } from '@nexus/factory-domain/insights/dashboards/boards'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import type { Reader } from '../facts/rows'
import { processReports } from '../reports/registry'
import { officeContextOf } from '../viewer'
import { boardFor } from './picker'

/**
 * Arrange a dashboard (B-W2b-434; design home.dashboards pop:arrange "Panels, order, widths; server-saved per person"; follow-up
 * DB1:01 "report panels pinnable to a dashboard, saved per person on the server, not per device"): GET, PUT and DELETE
 * /insights/dashboards/:board/layout. A person reads and saves only their own arrangement (the session's person, never an id in
 * the request), one per dashboard (DashboardLayout, key `dashboard:<userId>:<board>`). Version 0: nothing saved (the
 * dashboard's own order); the first save creates it, later ones send its version; DELETE goes back to the dashboard's order.
 * Rules: factory-domain insights/dashboards (layoutProblems, layoutOf). No event: nobody else reads a person's arrangement.
 */

const SELECT = { id: true, panels: true, version: true, updatedAt: true } as const satisfies Prisma.DashboardLayoutSelect
type Row = Prisma.DashboardLayoutGetPayload<{ select: typeof SELECT }>

/** The keys of the report pack (home.reports): a report of it may be pinned too. */
const packReports = (): ReadonlySet<string> => new Set(processReports().map((report) => report.key))

const storedPanels = (row: Row | null): LayoutPanel[] | null => (row ? (row.panels as unknown as LayoutPanel[]) : null)

const view = (entry: Board, row: Row | null) => ({
  board: entry.key,
  panels: layoutOf(entry, storedPanels(row), packReports()),
  saved: row !== null,
  version: row?.version ?? 0,
  updatedAt: row ? toUtcIso(row.updatedAt) : null,
})

async function rowOf(db: Reader, key: string): Promise<Row | null> {
  return db.dashboardLayout.findFirst({ where: { key }, select: SELECT })
}

async function lockRow(tx: CommandTx, key: string): Promise<Row | null> {
  await tx.$queryRaw`SELECT id FROM "DashboardLayout" WHERE "key" = ${key} FOR UPDATE`
  return rowOf(tx, key)
}

/** GET /insights/dashboards/:board/layout: my arrangement of a dashboard, or its own order when I saved none. */
export async function getDashboardLayout(caller: CommandCaller, boardKey: string) {
  const entry = boardFor(boardKey)
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => rowOf(db, layoutKey(context.actorId, entry.key)))
  return view(entry, row)
}

export interface LayoutBody {
  readonly panels: readonly { readonly id: string; readonly hidden: boolean; readonly width: string }[]
  readonly version: number
}

/** PUT /insights/dashboards/:board/layout (command insights.saveDashboardLayout). */
export async function saveDashboardLayout(caller: CommandCaller, boardKey: string, body: LayoutBody, idempotencyKey?: string) {
  const entry = boardFor(boardKey)
  const context = officeContextOf(caller)
  const problems = layoutProblems(entry, body.panels, packReports())
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The arrangement is not valid.', problems)
  const key = layoutKey(context.actorId, entry.key)
  const panels = body.panels.map((panel) => ({ id: panel.id, hidden: panel.hidden, width: panel.width as PanelWidth }))
  const { result } = await command(caller, { name: 'insights.saveDashboardLayout', idempotencyKey, input: { board: entry.key, ...body } }, async (tools) => {
    const existing = await lockRow(tools.tx, key)
    if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('DashboardLayout', existing?.id ?? key, existing?.version ?? 0, body.version)
    const stored = panels as unknown as Prisma.InputJsonValue
    const row = existing
      ? await tools.tx.dashboardLayout.update({ where: { id: existing.id }, data: { panels: stored, version: existing.version + 1, updatedAt: tools.now }, select: SELECT })
      : await tools.tx.dashboardLayout.create({ data: { id: newId(), userId: context.actorId, dashboardKey: entry.key, key, panels: stored, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: SELECT })
    tools.audit({ recordType: 'DashboardLayout', recordId: row.id, companyId: null, ...(existing ? { before: { board: entry.key, panels: existing.panels } } : {}), after: { board: entry.key, panels: stored } })
    return view(entry, row)
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Your arrangement was just saved from another window: read it again.')
    throw error
  })
  return result
}

/** DELETE /insights/dashboards/:board/layout?version= (command insights.resetDashboardLayout): back to the dashboard's order. */
export async function resetDashboardLayout(caller: CommandCaller, boardKey: string, version: number, idempotencyKey?: string) {
  const entry = boardFor(boardKey)
  const context = officeContextOf(caller)
  const key = layoutKey(context.actorId, entry.key)
  const { result } = await command(caller, { name: 'insights.resetDashboardLayout', idempotencyKey, input: { board: entry.key, version } }, async (tools) => {
    const existing = await lockRow(tools.tx, key)
    if (!existing) throw new NotFoundError('You have not arranged this dashboard: it already shows its own order.')
    if (existing.version !== version) throw new StaleVersionError('DashboardLayout', existing.id, existing.version, version)
    await tools.tx.dashboardLayout.delete({ where: { id: existing.id } })
    tools.audit({ recordType: 'DashboardLayout', recordId: existing.id, companyId: null, before: { board: entry.key, panels: existing.panels }, after: null })
    return view(entry, null)
  })
  return result
}

/**
 * GX.8 — saved views for the Reporting page.
 *
 * ── Why there is no migration here ────────────────────────────────────────────
 *
 * The platform already has a generic, surface-scoped `SavedView` table — name, a JSON payload
 * and a default flag, unique per (owner, surface, name). Products, fulfilment and the dashboard
 * all keep their views in it. A second table shaped the same way would be the inconsistency this
 * page exists to remove, so this is the same table under `surface = 'ads-reporting'`.
 *
 * ── Why its own routes, then ─────────────────────────────────────────────────
 *
 * `/api/saved-views` is mapped to the PRODUCTS permissions. An operator with the ads role and no
 * products access could read this page and not save what they were looking at, which is a
 * permission answering a question nobody asked. The routes that wrap this service sit under
 * `/api/advertising/reporting/`, where the manifest already grants `adsView` for a personal
 * saved object.
 *
 * ── 🔴 What a view actually holds ────────────────────────────────────────────
 *
 * The RAW localStorage entries for one tab, byte for byte, plus the tab and market from the URL.
 * Not a parsed model of them. The section layout, the grid columns and the chart heights are all
 * shapes their own components own, and a server that understood them would have to be changed
 * every time one of them gained a field — silently dropping whatever it had not been taught yet.
 * Storing the strings means this service is never the reason a view comes back incomplete.
 *
 * The cost of that choice is that the server cannot validate the contents, so it validates the
 * envelope instead: known tab, known market, a bounded number of bounded keys.
 */
import prisma from '../../db.js'

/**
 * Views are account-wide, matching every other saved object on this page (saved reports, share
 * links and schedules carry no owner either). The column is not dropped because the table is
 * shared with surfaces that will want per-user views later; it is the constant they all use.
 */
const OWNER = 'default-user'
const SURFACE = 'ads-reporting'

/** The four tabs that persist anything. Library and Explorer are deliberately absent — see the
 *  web-side `views.ts` for why: one already has saved reports, the other stores nothing. */
const TABS = new Set(['brand', 'market-share', 'business', 'hourly'])
const MARKETS = new Set(['all', 'IT', 'DE', 'ES', 'FR'])

/** Bounds on the envelope. Generous for a page of preferences, closed against a runaway writer. */
const MAX_KEYS = 40
const MAX_KEY_CHARS = 120
const MAX_TOTAL_CHARS = 64_000
const MAX_NAME_CHARS = 80

export interface ReportingViewPayload {
  tab: string
  market: string
  /** localStorage key → the raw stored string, exactly as the browser held it. */
  keys: Record<string, string>
}

export interface ReportingView {
  id: string
  name: string
  payload: ReportingViewPayload
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export class ViewError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new ViewError('A view needs a name.')
  if (n.length > MAX_NAME_CHARS) throw new ViewError(`A name is at most ${MAX_NAME_CHARS} characters.`)
  return n
}

/**
 * Validate the envelope and return a payload holding ONLY the fields we know about — an unknown
 * top-level field is dropped rather than stored, so a future reader never has to guess whether
 * something in here was ever meaningful.
 */
export function cleanPayload(input: unknown): ReportingViewPayload {
  const p = (input ?? {}) as Partial<ReportingViewPayload>
  if (!TABS.has(String(p.tab))) throw new ViewError(`A view must name one of: ${[...TABS].join(', ')}.`)
  if (!MARKETS.has(String(p.market))) throw new ViewError('Unknown market.')

  const raw = (p.keys && typeof p.keys === 'object') ? p.keys as Record<string, unknown> : {}
  const entries = Object.entries(raw)
  if (entries.length > MAX_KEYS) throw new ViewError(`A view holds at most ${MAX_KEYS} settings.`)

  const keys: Record<string, string> = {}
  let total = 0
  for (const [k, v] of entries) {
    // Only this page's own keys. A view must never be able to carry an entry that would overwrite
    // an unrelated part of the operator's browser storage when it is applied.
    if (!/^rpx-[a-z0-9-]+$/.test(k) || k.length > MAX_KEY_CHARS) {
      throw new ViewError(`"${k}" is not a Reporting setting.`)
    }
    if (typeof v !== 'string') throw new ViewError(`"${k}" must be stored as text.`)
    total += k.length + v.length
    if (total > MAX_TOTAL_CHARS) throw new ViewError('That view is too large to store.')
    keys[k] = v
  }
  return { tab: String(p.tab), market: String(p.market), keys }
}

type Row = { id: string; name: string; filters: unknown; isDefault: boolean; createdAt: Date; updatedAt: Date }

function toView(r: Row): ReportingView {
  const f = (r.filters ?? {}) as Partial<ReportingViewPayload>
  return {
    id: r.id,
    name: r.name,
    // Read back defensively: a row written by an older shape yields an empty, harmless view
    // rather than throwing and taking the whole list down with it.
    payload: {
      tab: typeof f.tab === 'string' ? f.tab : 'brand',
      market: typeof f.market === 'string' ? f.market : 'IT',
      keys: (f.keys && typeof f.keys === 'object') ? f.keys as Record<string, string> : {},
    },
    isDefault: r.isDefault,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listReportingViews(): Promise<ReportingView[]> {
  const rows = await prisma.savedView.findMany({
    where: { userId: OWNER, surface: SURFACE },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
  return rows.map(toView)
}

export async function createReportingView(input: {
  name: unknown; payload: unknown; isDefault?: boolean
}): Promise<ReportingView> {
  const name = cleanName(input.name)
  const payload = cleanPayload(input.payload)
  if (input.isDefault) await clearDefault()
  try {
    const row = await prisma.savedView.create({
      data: {
        userId: OWNER, surface: SURFACE, name,
        filters: payload as unknown as object,
        isDefault: !!input.isDefault,
      },
    })
    return toView(row)
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new ViewError('A view with that name already exists.', 409)
    }
    throw err
  }
}

export async function updateReportingView(id: string, input: {
  name?: unknown; payload?: unknown; isDefault?: boolean
}): Promise<ReportingView> {
  const existing = await prisma.savedView.findFirst({ where: { id, userId: OWNER, surface: SURFACE } })
  if (!existing) throw new ViewError('View not found.', 404)

  const data: { name?: string; filters?: object; isDefault?: boolean } = {}
  if (input.name !== undefined) data.name = cleanName(input.name)
  if (input.payload !== undefined) data.filters = cleanPayload(input.payload) as unknown as object
  if (input.isDefault !== undefined) {
    data.isDefault = !!input.isDefault
    if (input.isDefault) await clearDefault(id)
  }
  try {
    return toView(await prisma.savedView.update({ where: { id }, data }))
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new ViewError('A view with that name already exists.', 409)
    }
    throw err
  }
}

export async function deleteReportingView(id: string): Promise<void> {
  const n = await prisma.savedView.deleteMany({ where: { id, userId: OWNER, surface: SURFACE } })
  if (n.count === 0) throw new ViewError('View not found.', 404)
}

/** Scoped to this surface, so making an ads view the default never disturbs a products one. */
async function clearDefault(except?: string): Promise<void> {
  await prisma.savedView.updateMany({
    where: { userId: OWNER, surface: SURFACE, ...(except ? { id: { not: except } } : {}) },
    data: { isDefault: false },
  })
}

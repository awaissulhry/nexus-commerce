/**
 * VT.F item C(2) — the FUNCTIONALITY MATRIX: every cell state in design §3.4 × every scope × every commit
 * rule in §3.5, each cell a WITNESSED outcome.
 *
 * The cells are read from the LIVE `/studio/sheet` on the local API (never hand-written — a hand-seeded
 * fixture proves the TEST path, `reference_fixture_must_be_writer_produced`), and each is run through the
 * shipped `variationThemeWrite`, which is the ONE function the app's commit path calls. The outcome words are
 * the function's own: `request` (an endpoint + body), `plan` (the dry-run modal, nothing written), `refusal`
 * (a reason), `nothing` (an untouched edit).
 *
 * READ-ONLY: no PATCH is sent from this file. What it measures is the DECISION, which is what §3.5 specifies.
 */
/* 🔴 A DYNAMIC import with an explicit `.ts` extension. A static specifier resolves to the committed
   `sheetWriter.d.ts`, which `check-ds-dts-fresh` reports as one of 64 STALE declarations (Sep 6 against a
   Sep 13 source) — so the import failed with "does not provide an export named variationThemeWrite" for a
   function that has existed for hours. A stale declaration is not a missing export; that error is the
   declaration talking. */
const { variationThemeWrite } = await import('../apps/web/src/design-system/grid/editors/sheetWriter.ts')

const API = 'http://127.0.0.1:8091'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const FIX = 'cmtzci5kf0000njr9f8yhrsxm'
const AMZ = 'cmothu9bo0000nz01asw6wx8j', EBY = 'cmr4aaqb00025nz016k18rup9', SHP = 'cmtugfpaa0006njhq8m2nvnxx'

const SCOPES = [
  { key: 'master', q: 'market=IT' },
  { key: 'amazon·IT', q: `scope=channel&channel=AMAZON&market=IT&accountId=${AMZ}` },
  { key: 'amazon·DE', q: `scope=channel&channel=AMAZON&market=DE&accountId=${AMZ}` },
  { key: 'ebay·IT', q: `scope=channel&channel=EBAY&market=IT&accountId=${EBY}` },
  { key: 'shopify', q: `scope=channel&channel=SHOPIFY&market=GLOBAL&accountId=${SHP}` },
]

const COL = { kind: 'variationTheme' as const }
const outcome = (d: ReturnType<typeof variationThemeWrite>): string =>
  d.send ? `request → ${d.endpoint}` : 'plan' in d ? `plan (${d.plan.setChangeIs})` : d.reason === 'Nothing changed' ? 'nothing' : `refusal: ${d.reason.slice(0, 72)}`

type Cell = Record<string, unknown> & { axes?: Array<Record<string, unknown>> }

async function cellFor(productId: string, q: string): Promise<{ cell: Cell | null; child: Cell | null | undefined; state: string }> {
  const res = await fetch(`${API}/api/products/${productId}/studio/sheet?${q}`)
  const body = await res.json() as { rows?: Array<{ id?: string; productId?: string; values?: Record<string, { value?: unknown }> }> }
  const rows = body.rows ?? []
  const parent = rows.find((r) => (r.productId ?? r.id) === productId) ?? rows[0]
  const kid = rows.find((r) => (r.productId ?? r.id) !== productId)
  const cell = (parent?.values?.variation_theme?.value ?? null) as Cell | null
  const child = (kid?.values?.variation_theme?.value ?? null) as Cell | null
  const src = (cell?.source ?? {}) as { kind?: string; label?: string }
  const dropped = (cell?.dropped ?? []) as string[]
  const col = cell?.collisions as { unresolved?: number } | null
  const state = !cell ? 'no cell'
    : (cell.axes ?? []).length === 0 ? '`Set axes…` / no axes'
    : src.kind === 'none' ? '`Choose a theme` (warning)'
    : `${src.kind}${cell.locked ? ' + 🔒' : ''}${dropped.length ? ` + ${dropped.length} dropped` : ''}${col?.unresolved ? ` + collides ${col.unresolved}` : ''}`
  return { cell, child, state }
}

/* The five §3.5 commit rules, each as a draft DERIVED from the real cell — never a hand-built cell. */
const RULES: Array<{ name: string; draft: (c: Cell) => Cell | null }> = [
  { name: 'unchanged', draft: (c) => ({ ...c, baseline: c }) },
  { name: 'SET change (drop an axis)', draft: (c) => {
      const axes = (c.axes ?? []) as Array<Record<string, unknown>>
      if (axes.length < 2) return null
      return { ...c, baseline: c, axes: axes.map((a, i) => (i === axes.length - 1 ? { ...a, included: false } : a)) }
    } },
  { name: 'ORDER-only change', draft: (c) => {
      const axes = (c.axes ?? []) as Array<Record<string, unknown>>
      if (axes.length < 2) return null
      return { ...c, baseline: c, axes: [axes[axes.length - 1], ...axes.slice(0, -1)] }
    } },
  { name: 'THEME change', draft: (c) => {
      const items = ((c.candidates as { items?: Array<{ code: string; label: string; deprecated?: boolean }> } | null)?.items ?? [])
      const other = items.find((i) => i.code !== (c.theme as { code?: string } | null)?.code)
      if (!other) return null
      return { ...c, baseline: c, theme: { code: other.code, label: other.label, deprecated: !!other.deprecated } }
    } },
  { name: 'reset to rule', draft: (c) => ({ ...c, baseline: c, resetRequested: true }) },
]

for (const [label, id] of [['GALE-JACKET', GALE], ['VX-TEST-3AX', FIX]] as const) {
  for (const sc of SCOPES) {
    const { cell, child, state } = await cellFor(id, sc.q)
    console.log(`\n## ${label} · ${sc.key}`)
    console.log(`   STATE (§3.4): ${state}`)
    if (cell) {
      const src = cell.source as { label?: string }
      console.log(`   source label: ${JSON.stringify(src?.label)} · writable ${cell.writable} · locked ${cell.locked ? JSON.stringify((cell.locked as { setChangeIs?: string }).setChangeIs) : 'null'}`)
    }
    /* The CHILD row is its own §3.4 state, and it is measured, not assumed. */
    console.log(`   child row cell: ${JSON.stringify(child)} → ${outcome(variationThemeWrite(COL, child as never, child as never))}`)
    if (!cell) { console.log('   (no parent cell — every commit rule is moot)'); continue }
    for (const rule of RULES) {
      const draft = rule.draft(cell)
      if (!draft) { console.log(`   ${rule.name.padEnd(26)} NOT APPLICABLE on this cell (not enough axes / no other candidate)`); continue }
      console.log(`   ${rule.name.padEnd(26)} ${outcome(variationThemeWrite(COL, cell as never, draft as never))}`)
    }
  }
}

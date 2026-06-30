# Ads Mission Control — P1: Real Account Graph (read) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace P0's static sample graph with the **real account** rendered as Market → Portfolio → Campaign nodes (built client-side from the campaigns API), with **expand/collapse**, a populated **inspector**, and a **clean initial paint** (no empty flash).

**Architecture:** A pure `campaignsToObjects()` transforms the campaigns + portfolios API responses into `OpsObject[]` (markets/portfolios/campaigns with aggregated spend + health). A `useAccountGraph()` client hook fetches + transforms. `OpsCanvas` gains visible-filtering (expand/collapse) + selection; `MissionControlClient` owns expanded/selected state, the inspector, and loading/empty states. **No backend changes** — `ads-ontology.service` is untouched (so the budget-manager canvas is unaffected).

**Tech Stack:** Next.js/React, `@xyflow/react` v12 (installed), vitest (pure transforms), plain scoped CSS (light H10).

## Global Constraints

- Same H10 palette + **image-free** rule as P0 (see the P0 plan's Global Constraints; reuse `ops-canvas.css`/`mission-control.css`).
- **No new dependencies.** **No backend changes** (do NOT modify `ads-ontology.service` or any `apps/api` file). **Keep React Flow attribution.**
- Metrics from `/api/advertising/campaigns` are **strings|null** → always coerce with `Number()` + `Number.isFinite` before use.
- Reuse P0's `buildGraph`, `ObjectNode`, `OpsCanvas`, `types.ts` — extend, don't duplicate.
- `tsc` clean (`npx tsc --noEmit -p apps/web/tsconfig.json`); pure transforms unit-tested; native @2x screenshot verified before claiming done.
- Commit per task with `git commit <paths>` (working tree has unrelated WIP).

## File Structure

- Create: `apps/web/src/app/marketing/ads/_canvas/accountGraph.ts` — pure `campaignsToObjects`, `visibleObjects`, `childParentIds`.
- Create: `apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts`.
- Create: `apps/web/src/app/marketing/ads/_canvas/useAccountGraph.ts` — fetch + transform hook.
- Modify: `apps/web/src/app/marketing/ads/_canvas/types.ts` — extend `OpsNodeData` with `hasChildren?`, `expanded?`, `selected?`, `onToggle?`.
- Modify: `apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx` — expander button + selected styling.
- Modify: `apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx` — visible-filtering, inject node data + handlers, `onNodeClick` select.
- Modify: `apps/web/src/app/marketing/ads/_canvas/ops-canvas.css` — expander + selected styles.
- Modify: `apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx` — use hook, expanded/selected state, inspector, loading/empty.
- Modify: `apps/web/src/app/marketing/ads/autopilot/mission-control.css` — inspector + skeleton styles.

---

### Task 1: Pure account-graph transform (TDD)

**Files:**
- Create: `apps/web/src/app/marketing/ads/_canvas/accountGraph.ts`
- Test: `apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts`

**Interfaces:**
- Produces: `ApiCampaign`, `ApiPortfolio`, `campaignsToObjects(campaigns, portfolios?): OpsObject[]`, `visibleObjects(objects, expanded: Set<string>): OpsObject[]`, `childParentIds(objects): Set<string>`. Consumed by Tasks 2–4.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { campaignsToObjects, visibleObjects, childParentIds, type ApiCampaign } from './accountGraph'

const camps: ApiCampaign[] = [
  { id: '1', name: 'AIREON', marketplace: 'DE', portfolioId: 'pf1', spend: '310', acos: '0.24' },
  { id: '2', name: 'MISANO', marketplace: 'DE', portfolioId: null, spend: '190', acos: '0.61' },
  { id: '3', name: 'GALE', marketplace: 'IT', portfolioId: null, spend: null, acos: null },
]

describe('campaignsToObjects', () => {
  it('builds market/portfolio/campaign objects with parent links and aggregated spend', () => {
    const objs = campaignsToObjects(camps, [{ portfolioId: 'pf1', name: 'Moto Jackets' }])
    const de = objs.find((o) => o.id === 'm:DE')!
    expect(de.kind).toBe('market')
    expect(de.spend).toBe(500) // 310 + 190
    const moto = objs.find((o) => o.id === 'p:DE:pf1')!
    expect(moto.name).toBe('Moto Jackets')
    expect(moto.parentId).toBe('m:DE')
    const noPf = objs.find((o) => o.id === 'p:DE:none')!
    expect(noPf.name).toBe('No portfolio')
    const aireon = objs.find((o) => o.id === 'c:1')!
    expect(aireon.parentId).toBe('p:DE:pf1')
    expect(aireon.health).toBe('ok') // 0.24
    expect(objs.find((o) => o.id === 'c:2')!.health).toBe('bad') // 0.61
  })

  it('coerces string/null metrics safely', () => {
    const gale = campaignsToObjects(camps).find((o) => o.id === 'c:3')!
    expect(gale.spend).toBeUndefined()
    expect(gale.acos).toBeUndefined()
    expect(gale.health).toBe('ok')
  })
})

describe('visibleObjects', () => {
  it('shows roots always; children only when every ancestor is expanded', () => {
    const objs = campaignsToObjects(camps, [])
    const noneExpanded = visibleObjects(objs, new Set())
    expect(noneExpanded.every((o) => o.kind === 'market')).toBe(true)
    const deExpanded = visibleObjects(objs, new Set(['m:DE']))
    expect(deExpanded.some((o) => o.id === 'p:DE:pf1')).toBe(true)
    expect(deExpanded.some((o) => o.id === 'c:1')).toBe(false) // portfolio not expanded
  })
})

describe('childParentIds', () => {
  it('returns the set of ids that are someone\'s parent', () => {
    const objs = campaignsToObjects(camps, [])
    const s = childParentIds(objs)
    expect(s.has('m:DE')).toBe(true)
    expect(s.has('c:1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts`
Expected: FAIL — cannot resolve `./accountGraph`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/app/marketing/ads/_canvas/accountGraph.ts
import type { OpsObject, Health } from './types'

export interface ApiCampaign {
  id: string
  name: string
  marketplace: string | null
  portfolioId?: string | null
  spend?: number | string | null
  acos?: number | string | null
}
export interface ApiPortfolio {
  portfolioId: string
  name: string
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function healthFromAcos(acos?: number): Health {
  if (acos === undefined) return 'ok'
  if (acos > 0.5) return 'bad'
  if (acos > 0.35) return 'warn'
  return 'ok'
}

const NO_PF = 'none'

export function campaignsToObjects(campaigns: ApiCampaign[], portfolios: ApiPortfolio[] = []): OpsObject[] {
  const pfName = new Map(portfolios.map((p) => [p.portfolioId, p.name]))
  const marketSpend = new Map<string, number>()
  const pfAgg = new Map<string, { market: string; pid: string; spend: number }>()
  const campaignObjs: OpsObject[] = []

  for (const c of campaigns) {
    const market = c.marketplace || 'Unknown'
    const pid = c.portfolioId || NO_PF
    const pfKey = `${market}:${pid}`
    const spend = num(c.spend) ?? 0
    const acos = num(c.acos)
    marketSpend.set(market, (marketSpend.get(market) ?? 0) + spend)
    const cur = pfAgg.get(pfKey) ?? { market, pid, spend: 0 }
    cur.spend += spend
    pfAgg.set(pfKey, cur)
    campaignObjs.push({
      id: `c:${c.id}`,
      kind: 'campaign',
      name: c.name,
      parentId: `p:${pfKey}`,
      spend: spend || undefined,
      acos,
      health: healthFromAcos(acos),
    })
  }

  const marketObjs: OpsObject[] = [...marketSpend.entries()].map(([m, spend]) => ({
    id: `m:${m}`,
    kind: 'market',
    name: m,
    spend: spend || undefined,
    health: 'ok',
  }))
  const pfObjs: OpsObject[] = [...pfAgg.entries()].map(([key, v]) => ({
    id: `p:${key}`,
    kind: 'portfolio',
    name: v.pid === NO_PF ? 'No portfolio' : pfName.get(v.pid) ?? v.pid,
    parentId: `m:${v.market}`,
    spend: v.spend || undefined,
    health: 'ok',
  }))
  return [...marketObjs, ...pfObjs, ...campaignObjs]
}

export function visibleObjects(objects: OpsObject[], expanded: Set<string>): OpsObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const visible = (o: OpsObject): boolean => {
    if (!o.parentId) return true
    const parent = byId.get(o.parentId)
    if (!parent) return true
    return expanded.has(parent.id) && visible(parent)
  }
  return objects.filter(visible)
}

export function childParentIds(objects: OpsObject[]): Set<string> {
  const s = new Set<string>()
  for (const o of objects) if (o.parentId) s.add(o.parentId)
  return s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/accountGraph.ts apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts
git commit apps/web/src/app/marketing/ads/_canvas/accountGraph.ts apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts -m "feat(ads-mc): P1 pure account-graph transform (campaigns -> market/portfolio/campaign)"
```

---

### Task 2: Data hook

**Files:** Create `apps/web/src/app/marketing/ads/_canvas/useAccountGraph.ts`

**Interfaces:**
- Consumes: `campaignsToObjects`, `ApiCampaign`, `ApiPortfolio`.
- Produces: `useAccountGraph(): { objects: OpsObject[]; loading: boolean; error: string | null }`. Consumed by Task 5.

- [ ] **Step 1: Write the hook**

```ts
// apps/web/src/app/marketing/ads/_canvas/useAccountGraph.ts
'use client'
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignsToObjects, type ApiCampaign, type ApiPortfolio } from './accountGraph'
import type { OpsObject } from './types'

export function useAccountGraph(): { objects: OpsObject[]; loading: boolean; error: string | null } {
  const [objects, setObjects] = useState<OpsObject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const base = getBackendUrl()
        const [cr, pr] = await Promise.all([
          fetch(`${base}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }),
          fetch(`${base}/api/advertising/portfolios`, { cache: 'no-store' }).catch(() => null),
        ])
        const cd = await cr.json()
        const pd = pr && pr.ok ? await pr.json() : { portfolios: [] }
        if (!alive) return
        const campaigns = (cd.items ?? []) as ApiCampaign[]
        const portfolios = (pd.portfolios ?? []) as ApiPortfolio[]
        setObjects(campaignsToObjects(campaigns, portfolios))
        setError(null)
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? 'Failed to load account graph')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return { objects, loading, error }
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit -p apps/web/tsconfig.json` (no errors in `_canvas/useAccountGraph.ts`).
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/useAccountGraph.ts
git commit apps/web/src/app/marketing/ads/_canvas/useAccountGraph.ts -m "feat(ads-mc): P1 useAccountGraph data hook (campaigns + portfolios)"
```

---

### Task 3: Extend types + ObjectNode (expander + selected)

**Files:** Modify `types.ts`, `ObjectNode.tsx`, `ops-canvas.css`.

**Interfaces:**
- Produces: `OpsNodeData` gains optional `hasChildren`, `expanded`, `selected`, `onToggle`. `ObjectNode` renders an expander when `hasChildren` and a selected ring when `selected`.

- [ ] **Step 1: Extend `OpsNodeData` in `types.ts`** — add to the interface:

```ts
export interface OpsNodeData {
  kind: ObjectKind
  name: string
  spend?: number
  acos?: number
  health?: Health
  hasChildren?: boolean
  expanded?: boolean
  selected?: boolean
  onToggle?: () => void
}
```

- [ ] **Step 2: Update `ObjectNode.tsx`** — replace its body with:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { OpsNodeData } from './types'

const KIND_LABEL: Record<string, string> = {
  market: 'Market',
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  adgroup: 'Ad Group',
  target: 'Target',
}

export function ObjectNode({ data }: NodeProps) {
  const d = data as unknown as OpsNodeData
  const health = d.health ?? 'ok'
  return (
    <div className={`opsn opsn--${health}${d.selected ? ' opsn--sel' : ''}`}>
      <Handle type="target" position={Position.Left} className="opsn-h" />
      <div className="opsn-kind">{KIND_LABEL[d.kind] ?? d.kind}</div>
      <div className="opsn-title">{d.name}</div>
      <div className="opsn-meta">
        <span className={`opsn-dot opsn-dot--${health}`} />
        <span>{typeof d.spend === 'number' ? `€${Math.round(d.spend).toLocaleString()}` : '—'}</span>
        {typeof d.acos === 'number' && <span>· {Math.round(d.acos * 100)}%</span>}
      </div>
      {d.hasChildren && (
        <button
          type="button"
          className="opsn-exp"
          onClick={(e) => {
            e.stopPropagation()
            d.onToggle?.()
          }}
          aria-label={d.expanded ? 'Collapse' : 'Expand'}
        >
          {d.expanded ? '−' : '+'}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="opsn-h" />
    </div>
  )
}
```

- [ ] **Step 3: Append to `ops-canvas.css`:**

```css
.opsn--sel { border-color: #1f6fde; box-shadow: 0 0 0 3px #dce8fb, 0 2px 6px rgba(31, 111, 222, 0.18); }
.opsn-exp {
  position: absolute; right: -10px; top: 50%; transform: translateY(-50%);
  width: 18px; height: 18px; border-radius: 50%; border: 1px solid #cfd5dd;
  background: #fff; color: #1f6fde; font-weight: 800; font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
}
.opsn-exp:hover { background: #eef3fb; }
```

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit -p apps/web/tsconfig.json`.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/types.ts apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx apps/web/src/app/marketing/ads/_canvas/ops-canvas.css
git commit apps/web/src/app/marketing/ads/_canvas/types.ts apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx apps/web/src/app/marketing/ads/_canvas/ops-canvas.css -m "feat(ads-mc): P1 ObjectNode expander + selected state"
```

---

### Task 4: OpsCanvas — visible filtering, selection, data injection

**Files:** Modify `apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx`.

**Interfaces:**
- Consumes: `visibleObjects`, `childParentIds` (Task 1), `buildGraph` (P0).
- Produces: `OpsCanvas({ objects, expanded, onToggleExpand, selectedId, onSelect })`.

- [ ] **Step 1: Replace `OpsCanvas.tsx` with:**

```tsx
'use client'
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './ops-canvas.css'
import { ObjectNode } from './ObjectNode'
import { buildGraph } from './buildGraph'
import { visibleObjects, childParentIds } from './accountGraph'
import type { OpsObject } from './types'

const nodeTypes = { object: ObjectNode }

export function OpsCanvas({
  objects,
  expanded,
  onToggleExpand,
  selectedId,
  onSelect,
}: {
  objects: OpsObject[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const visible = visibleObjects(objects, expanded)
  const parents = childParentIds(objects)
  const { nodes, edges } = buildGraph(visible)
  const enriched = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      hasChildren: parents.has(n.id),
      expanded: expanded.has(n.id),
      selected: selectedId === n.id,
      onToggle: () => onToggleExpand(n.id),
    },
  }))
  return (
    <div className="ops-canvas">
      <ReactFlow
        nodes={enriched as unknown as Node[]}
        edges={edges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        minZoom={0.3}
        onNodeClick={(_, node) => onSelect(node.id)}
      >
        <Background gap={22} color="#dfe4ea" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit -p apps/web/tsconfig.json`.
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx
git commit apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx -m "feat(ads-mc): P1 OpsCanvas expand/collapse + selection"
```

---

### Task 5: MissionControlClient — real data, state, inspector, clean paint

**Files:** Modify `MissionControlClient.tsx`, `mission-control.css`.

**Interfaces:**
- Consumes: `useAccountGraph` (Task 2), `OpsCanvas` (Task 4), `OpsObject`.

- [ ] **Step 1: Replace `MissionControlClient.tsx` with:**

```tsx
'use client'
import { useMemo, useState } from 'react'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { useAccountGraph } from '../_canvas/useAccountGraph'
import './mission-control.css'

const KIND_LABEL: Record<string, string> = {
  market: 'Market', portfolio: 'Portfolio', campaign: 'Campaign', adgroup: 'Ad Group', target: 'Target',
}

export function MissionControlClient() {
  const { objects, loading, error } = useAccountGraph()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Default: expand all markets once data arrives (clean first paint, not empty).
  const markets = useMemo(() => objects.filter((o) => o.kind === 'market').map((o) => o.id), [objects])
  const expandedReady = expanded.size > 0 || markets.length === 0 ? expanded : new Set(markets)

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev.size === 0 ? markets : prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const selected = objects.find((o) => o.id === selectedId) || null

  return (
    <div className="mc-root">
      <header className="mc-head">
        <div className="mc-titlewrap">
          <div className="mc-eyebrow">Nexus Ads</div>
          <h1 className="mc-title">Mission Control</h1>
        </div>
        <div className="mc-actions">
          <span className="mc-chip">All markets</span>
          <span className="mc-chip">Last 30 days</span>
          <span className="mc-chip mc-chip--auto">Autonomy: SUGGEST</span>
          <span className="mc-chip mc-chip--kill">Halt all</span>
        </div>
      </header>
      <div className="mc-body">
        <div className="mc-canvas-wrap">
          {loading && <div className="mc-state">Loading account graph…</div>}
          {!loading && error && <div className="mc-state mc-state--err">Couldn’t load: {error}</div>}
          {!loading && !error && objects.length === 0 && (
            <div className="mc-state">No campaigns found for this account yet.</div>
          )}
          {!loading && !error && objects.length > 0 && (
            <OpsCanvas
              objects={objects}
              expanded={expandedReady}
              onToggleExpand={toggle}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <aside className="mc-inspector" aria-label="Inspector">
          {selected ? (
            <div>
              <div className="mc-insp-kind">{KIND_LABEL[selected.kind] ?? selected.kind}</div>
              <div className="mc-insp-name">{selected.name}</div>
              <dl className="mc-insp-kv">
                <dt>Spend (30d)</dt>
                <dd>{typeof selected.spend === 'number' ? `€${Math.round(selected.spend).toLocaleString()}` : '—'}</dd>
                <dt>ACoS</dt>
                <dd>{typeof selected.acos === 'number' ? `${Math.round(selected.acos * 100)}%` : '—'}</dd>
                <dt>Health</dt>
                <dd>{selected.health ?? 'ok'}</dd>
              </dl>
              <div className="mc-insp-soon">Actions &amp; governing agents arrive in a later phase.</div>
            </div>
          ) : (
            <div className="mc-insp-empty">Select an object to inspect</div>
          )}
        </aside>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Append to `mission-control.css`:**

```css
.mc-state { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 560px; color: #8a93a1; font-size: 14px; }
.mc-state--err { color: #e5484d; }
.mc-insp-kind { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 800; color: #9aa3b0; }
.mc-insp-name { font-weight: 800; font-size: 16px; color: #1c2530; margin: 2px 0 12px; }
.mc-insp-kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; margin: 0; }
.mc-insp-kv dt { color: #8a93a1; font-size: 12px; }
.mc-insp-kv dd { margin: 0; font-weight: 700; font-size: 12px; color: #1c2530; text-align: right; }
.mc-insp-soon { margin-top: 14px; font-size: 11px; color: #8a93a1; }
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit -p apps/web/tsconfig.json` (clean).
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx apps/web/src/app/marketing/ads/autopilot/mission-control.css
git commit apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx apps/web/src/app/marketing/ads/autopilot/mission-control.css -m "feat(ads-mc): P1 real account graph + expand/collapse + inspector + loading states"
```

---

### Task 6: Verify + screenshot

- [ ] **Step 1:** `npx tsc --noEmit -p apps/web/tsconfig.json` → clean.
- [ ] **Step 2:** `npx vitest run apps/web/src/app/marketing/ads/_canvas/` → all `buildGraph` + `accountGraph` tests pass.
- [ ] **Step 3:** Isolated dev (`cd apps/web && NEXT_DEV_ISOLATED=1 npx next dev -p 3007`), warm `/marketing/ads/autopilot` (cold prod API → wait for real campaigns).
- [ ] **Step 4:** Screenshot @2x. Verify: markets render from REAL data (not the sample 6), expanding a market reveals its portfolios ("No portfolio" bucket present), clicking a node fills the inspector, no empty-flash on load (loading state shows first). Fix + re-screenshot if any check fails.
- [ ] **Step 5:** Present to owner for sign-off; on approval, push.

---

## Self-Review

**1. Spec coverage (P1):** real ontology rendered ✓ (Tasks 1–2, 5 — client-side from campaigns API, no `ads-ontology` change); Market+Portfolio levels above campaigns ✓ (Task 1); expand/collapse ✓ (Tasks 3–5); inspector populated ✓ (Task 5); clean initial paint ✓ (Task 5 loading state + expand-markets default). Ad-group/target drill + report panels correctly deferred to P2.

**2. Placeholder scan:** every step has complete code + exact commands. ✓

**3. Type consistency:** `OpsObject`/`OpsNodeData` extended in Task 3 and used by Task 4 (`onToggle`, `hasChildren`, `expanded`, `selected`) + Task 5. `campaignsToObjects`/`visibleObjects`/`childParentIds` defined Task 1, consumed Tasks 2 & 4. `useAccountGraph` return shape matches Task 5 usage. ✓

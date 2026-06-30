# Ads Mission Control — P0: Canvas Foundation + Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a shared React Flow `<OpsCanvas>` and rebuild `/marketing/ads/autopilot` as the **Mission Control** shell that renders a few real object nodes (Market → Portfolio → Campaign) with proper anchored edges, pan/zoom, and a minimap — the foundation + the fidelity sign-off for the program.

**Architecture:** A pure `buildGraph()` transforms a list of ontology objects into React Flow `{nodes, edges}` with a deterministic hand-rolled hierarchical layout (no layout library). `<OpsCanvas>` wraps `@xyflow/react` with a custom `ObjectNode` styled in light H10 tokens (image-free). `MissionControlClient` is the page shell (header + canvas + empty inspector slot), fed static sample data for P0 (real ontology wiring is P1).

**Tech Stack:** Next.js (App Router), React, TypeScript, `@xyflow/react` v12 (already installed), vitest (pure-logic tests), plain scoped CSS using the existing H10 hex palette.

## Global Constraints

- **Design system / look:** light H10 only. Palette (verbatim): ink `#1c2530`, secondary `#5b6573`, muted `#8a93a1`, border `#e3e7ec` / `#dde2e8`, surface `#fff`, canvas `#fbfcfd`, primary `#1f6fde`, ok `#067d62`, warn `#b87503`, danger `#e5484d`, grid dot `#dfe4ea`, handle `#b6c0cd`. **Image-free** (no `<img>`, no product photos, no emoji; crisp text + dots only).
- **No new dependencies.** Use only `@xyflow/react` (already in `apps/web/package.json` at `^12.11.1`). No dagre/elk, no Blueprint, no React Flow **Pro**.
- **Keep React Flow attribution visible** (do NOT set `proOptions.hideAttribution` — that requires a Pro license, which is ruled out).
- **Do NOT delete** `apps/web/src/app/marketing/ads/autopilot/AutopilotControlRoom.tsx` or `AutopilotCanvas.tsx` — they hold the live plan/SSE/decision logic reused in later phases. P0 only changes what `page.tsx` renders.
- **No writes / no Amazon mutations** in P0 — it is read-only UI with static sample data.
- **Verify before claiming done:** `npx tsc --noEmit -p apps/web/tsconfig.json` clean; the vitest file passes; native @2x screenshot reviewed.
- **Commit cadence:** one commit per task. Use `git commit <paths>` (not `-a`) — the working tree has unrelated WIP; never stage files you didn't create/modify in the task.

---

## File Structure

- `apps/web/src/app/marketing/ads/_canvas/types.ts` — shared canvas types (`OpsObject`, `OpsNode`, `OpsEdge`, `OpsGraph`, `ObjectKind`, `Health`).
- `apps/web/src/app/marketing/ads/_canvas/buildGraph.ts` — pure objects → graph transform + layout constants.
- `apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts` — unit tests for `buildGraph`.
- `apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx` — custom React Flow node (DS/H10 styled, image-free).
- `apps/web/src/app/marketing/ads/_canvas/ops-canvas.css` — node + canvas styling (light H10).
- `apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx` — React Flow wrapper component.
- `apps/web/src/app/marketing/ads/_canvas/sampleData.ts` — static P0 fixture.
- `apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx` — page shell (header + canvas + inspector slot).
- `apps/web/src/app/marketing/ads/autopilot/mission-control.css` — shell styling.
- `apps/web/src/app/marketing/ads/autopilot/page.tsx` — MODIFY to render `MissionControlClient`.

---

### Task 1: Types + pure graph builder

**Files:**
- Create: `apps/web/src/app/marketing/ads/_canvas/types.ts`
- Create: `apps/web/src/app/marketing/ads/_canvas/buildGraph.ts`
- Test: `apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts`

**Interfaces:**
- Produces: `OpsObject` (input), `OpsGraph = { nodes: OpsNode[]; edges: OpsEdge[] }`, `buildGraph(objects: OpsObject[]): OpsGraph`, constants `COL_WIDTH = 220`, `ROW_HEIGHT = 92`. Consumed by Tasks 3 & 4.

- [ ] **Step 1: Write the types file**

```ts
// apps/web/src/app/marketing/ads/_canvas/types.ts
export type ObjectKind = 'market' | 'portfolio' | 'campaign' | 'adgroup' | 'target'
export type Health = 'ok' | 'warn' | 'bad'

export interface OpsObject {
  id: string
  kind: ObjectKind
  name: string
  parentId?: string
  spend?: number // EUR
  acos?: number  // fraction, e.g. 0.24 = 24%
  health?: Health
}

export interface OpsNodeData {
  kind: ObjectKind
  name: string
  spend?: number
  acos?: number
  health?: Health
}

export interface OpsNode {
  id: string
  type: 'object'
  position: { x: number; y: number }
  data: OpsNodeData
}

export interface OpsEdge {
  id: string
  source: string
  target: string
  type: 'smoothstep'
}

export interface OpsGraph {
  nodes: OpsNode[]
  edges: OpsEdge[]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { buildGraph, COL_WIDTH, ROW_HEIGHT } from './buildGraph'
import type { OpsObject } from './types'

describe('buildGraph', () => {
  it('places objects in columns by hierarchy level and links parent to child', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'p1', kind: 'portfolio', name: 'Moto', parentId: 'm1' },
      { id: 'c1', kind: 'campaign', name: 'AIREON', parentId: 'p1' },
    ]
    const { nodes, edges } = buildGraph(objects)
    expect(nodes).toHaveLength(3)
    expect(nodes.find((n) => n.id === 'm1')!.position).toEqual({ x: 0, y: 0 })
    expect(nodes.find((n) => n.id === 'p1')!.position).toEqual({ x: COL_WIDTH, y: 0 })
    expect(nodes.find((n) => n.id === 'c1')!.position).toEqual({ x: 2 * COL_WIDTH, y: 0 })
    expect(edges).toEqual([
      { id: 'm1->p1', source: 'm1', target: 'p1', type: 'smoothstep' },
      { id: 'p1->c1', source: 'p1', target: 'c1', type: 'smoothstep' },
    ])
  })

  it('stacks siblings on the same level by ROW_HEIGHT', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'm2', kind: 'market', name: 'IT' },
    ]
    const { nodes } = buildGraph(objects)
    expect(nodes.find((n) => n.id === 'm1')!.position).toEqual({ x: 0, y: 0 })
    expect(nodes.find((n) => n.id === 'm2')!.position).toEqual({ x: 0, y: ROW_HEIGHT })
  })

  it('drops edges whose parent is missing', () => {
    const { edges } = buildGraph([{ id: 'c1', kind: 'campaign', name: 'x', parentId: 'ghost' }])
    expect(edges).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run (from repo root): `npx vitest run apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts`
Expected: FAIL — `Failed to resolve import "./buildGraph"` (module not yet created).

- [ ] **Step 4: Write the implementation**

```ts
// apps/web/src/app/marketing/ads/_canvas/buildGraph.ts
import type { OpsObject, OpsGraph, ObjectKind } from './types'

const LEVELS: ObjectKind[] = ['market', 'portfolio', 'campaign', 'adgroup', 'target']
export const COL_WIDTH = 220
export const ROW_HEIGHT = 92

export function buildGraph(objects: OpsObject[]): OpsGraph {
  const rowCursor: Record<number, number> = {}
  const nodes = objects.map((o) => {
    const depth = LEVELS.indexOf(o.kind)
    const level = depth < 0 ? LEVELS.length : depth
    const row = rowCursor[level] ?? 0
    rowCursor[level] = row + 1
    return {
      id: o.id,
      type: 'object' as const,
      position: { x: level * COL_WIDTH, y: row * ROW_HEIGHT },
      data: { kind: o.kind, name: o.name, spend: o.spend, acos: o.acos, health: o.health },
    }
  })
  const ids = new Set(objects.map((o) => o.id))
  const edges = objects
    .filter((o) => o.parentId && ids.has(o.parentId))
    .map((o) => ({
      id: `${o.parentId}->${o.id}`,
      source: o.parentId as string,
      target: o.id,
      type: 'smoothstep' as const,
    }))
  return { nodes, edges }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/types.ts \
        apps/web/src/app/marketing/ads/_canvas/buildGraph.ts \
        apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts
git commit -m "feat(ads-mc): P0 pure graph builder + canvas types"
```

---

### Task 2: ObjectNode + canvas CSS

**Files:**
- Create: `apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx`
- Create: `apps/web/src/app/marketing/ads/_canvas/ops-canvas.css`

**Interfaces:**
- Consumes: `OpsNodeData` from `./types`.
- Produces: `ObjectNode` (React Flow node component) + CSS classes `.ops-canvas`, `.opsn*`. Registered by Task 3 under `nodeTypes.object`.

- [ ] **Step 1: Write the node component**

```tsx
// apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx
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
  const d = data as OpsNodeData
  const health = d.health ?? 'ok'
  return (
    <div className={`opsn opsn--${health}`}>
      <Handle type="target" position={Position.Left} className="opsn-h" />
      <div className="opsn-kind">{KIND_LABEL[d.kind] ?? d.kind}</div>
      <div className="opsn-title">{d.name}</div>
      <div className="opsn-meta">
        <span className={`opsn-dot opsn-dot--${health}`} />
        <span>{typeof d.spend === 'number' ? `€${d.spend.toLocaleString()}` : '—'}</span>
        {typeof d.acos === 'number' && <span>· {Math.round(d.acos * 100)}%</span>}
      </div>
      <Handle type="source" position={Position.Right} className="opsn-h" />
    </div>
  )
}
```

- [ ] **Step 2: Write the CSS**

```css
/* apps/web/src/app/marketing/ads/_canvas/ops-canvas.css */
.ops-canvas { width: 100%; height: 100%; min-height: 560px; background: #fbfcfd; }

.opsn {
  width: 152px;
  background: #fff;
  border: 1px solid #dde2e8;
  border-left: 3px solid #1f6fde;
  border-radius: 9px;
  padding: 7px 9px;
  box-shadow: 0 1px 2px rgba(20, 28, 38, 0.05);
  font: 12px/1.4 var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #1c2530;
}
.opsn--warn { border-left-color: #b87503; }
.opsn--bad { border-left-color: #e5484d; }
.opsn-kind { font-size: 8px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 800; color: #9aa3b0; }
.opsn-title { font-weight: 700; font-size: 11.5px; margin: 1px 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.opsn-meta { font-size: 9.5px; color: #5b6573; display: flex; align-items: center; gap: 4px; }
.opsn-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: #067d62; }
.opsn-dot--warn { background: #b87503; }
.opsn-dot--bad { background: #e5484d; }
.opsn-h { width: 7px; height: 7px; background: #b6c0cd; border: none; }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: no new errors referencing `_canvas/ObjectNode.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/ObjectNode.tsx \
        apps/web/src/app/marketing/ads/_canvas/ops-canvas.css
git commit -m "feat(ads-mc): P0 ObjectNode + H10 canvas styling"
```

---

### Task 3: OpsCanvas wrapper

**Files:**
- Create: `apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx`

**Interfaces:**
- Consumes: `buildGraph` (Task 1), `ObjectNode` (Task 2), `OpsObject` (Task 1).
- Produces: `OpsCanvas({ objects }: { objects: OpsObject[] })`. Consumed by Task 4.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx
'use client'
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './ops-canvas.css'
import { ObjectNode } from './ObjectNode'
import { buildGraph } from './buildGraph'
import type { OpsObject } from './types'

const nodeTypes = { object: ObjectNode }

export function OpsCanvas({ objects }: { objects: OpsObject[] }) {
  const { nodes, edges } = buildGraph(objects)
  return (
    <div className="ops-canvas">
      <ReactFlow
        nodes={nodes as unknown as Node[]}
        edges={edges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        minZoom={0.3}
      >
        <Background gap={22} color="#dfe4ea" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
```

> Note: do NOT add `proOptions={{ hideAttribution: true }}` — hiding the React Flow attribution requires a Pro license (ruled out). The small "React Flow" mark stays.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: no new errors referencing `_canvas/OpsCanvas.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/OpsCanvas.tsx
git commit -m "feat(ads-mc): P0 OpsCanvas React Flow wrapper"
```

---

### Task 4: Sample data + Mission Control shell + page wiring

**Files:**
- Create: `apps/web/src/app/marketing/ads/_canvas/sampleData.ts`
- Create: `apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx`
- Create: `apps/web/src/app/marketing/ads/autopilot/mission-control.css`
- Modify: `apps/web/src/app/marketing/ads/autopilot/page.tsx`

**Interfaces:**
- Consumes: `OpsCanvas` (Task 3), `OpsObject` (Task 1).
- Produces: `MissionControlClient()` rendered by `page.tsx`.

- [ ] **Step 1: Write the sample fixture**

```ts
// apps/web/src/app/marketing/ads/_canvas/sampleData.ts
import type { OpsObject } from './types'

export const SAMPLE_OBJECTS: OpsObject[] = [
  { id: 'de', kind: 'market', name: 'DE · Germany', spend: 1240, acos: 0.22, health: 'ok' },
  { id: 'it', kind: 'market', name: 'IT · Italy', spend: 2980, acos: 0.19, health: 'ok' },
  { id: 'de-moto', kind: 'portfolio', name: 'Moto Jackets', parentId: 'de', spend: 840, acos: 0.24, health: 'ok' },
  { id: 'de-helm', kind: 'portfolio', name: 'Helmets', parentId: 'de', spend: 400, acos: 0.38, health: 'warn' },
  { id: 'aireon', kind: 'campaign', name: 'AIREON Jacket', parentId: 'de-moto', spend: 310, acos: 0.24, health: 'ok' },
  { id: 'misano', kind: 'campaign', name: 'MISANO SP-Auto', parentId: 'de-moto', spend: 190, acos: 0.61, health: 'bad' },
]
```

- [ ] **Step 2: Write the shell component**

```tsx
// apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx
'use client'
import { OpsCanvas } from '../_canvas/OpsCanvas'
import { SAMPLE_OBJECTS } from '../_canvas/sampleData'
import './mission-control.css'

export function MissionControlClient() {
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
          <OpsCanvas objects={SAMPLE_OBJECTS} />
        </div>
        <aside className="mc-inspector" aria-label="Inspector">
          <div className="mc-insp-empty">Select an object to inspect</div>
        </aside>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Write the shell CSS**

```css
/* apps/web/src/app/marketing/ads/autopilot/mission-control.css */
.mc-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.mc-head { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid #e3e7ec; background: #fff; }
.mc-eyebrow { font-size: 11px; color: #8a93a1; font-weight: 600; }
.mc-title { font-size: 20px; font-weight: 800; color: #1c2530; margin: 0; }
.mc-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mc-chip { border: 1px solid #e3e7ec; border-radius: 7px; padding: 5px 10px; font-size: 12px; font-weight: 700; color: #5b6573; background: #fff; }
.mc-chip--auto { background: #1f6fde; color: #fff; border-color: #1f6fde; }
.mc-chip--kill { color: #e5484d; border-color: #f3c0c2; }
.mc-body { flex: 1; min-height: 0; display: flex; }
.mc-canvas-wrap { flex: 1; min-width: 0; min-height: 560px; }
.mc-inspector { width: 280px; flex: 0 0 280px; border-left: 1px solid #e3e7ec; background: #fff; padding: 16px; }
.mc-insp-empty { color: #8a93a1; font-size: 13px; }
```

> The autopilot page renders inside the ads shell's `.h10-main` (padded, full height via the `.h10-shell` 100dvh flex chain). `.mc-root { height: 100% }` + the `min-height: 560px` on the canvas wrap guarantees React Flow always has a sized container even if the flex chain is interrupted.

- [ ] **Step 4: Modify the page to render the shell**

Replace the contents of `apps/web/src/app/marketing/ads/autopilot/page.tsx` with:

```tsx
// apps/web/src/app/marketing/ads/autopilot/page.tsx
import { MissionControlClient } from './MissionControlClient'

export default function AutopilotPage() {
  return <MissionControlClient />
}
```

> If the existing `page.tsx` exports `metadata` or other named exports, keep them — only swap the default export's rendered component from `AutopilotControlRoom` to `MissionControlClient`. **Do not delete `AutopilotControlRoom.tsx`.**

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean (no errors in `_canvas/*` or `autopilot/*`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/marketing/ads/_canvas/sampleData.ts \
        apps/web/src/app/marketing/ads/autopilot/MissionControlClient.tsx \
        apps/web/src/app/marketing/ads/autopilot/mission-control.css \
        apps/web/src/app/marketing/ads/autopilot/page.tsx
git commit -m "feat(ads-mc): P0 Mission Control shell + sample graph on /autopilot"
```

---

### Task 5: Render verification + fidelity sign-off

**Files:** none (verification only).

- [ ] **Step 1: Full web typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean.

- [ ] **Step 2: Run the unit test**

Run: `npx vitest run apps/web/src/app/marketing/ads/_canvas/buildGraph.vitest.test.ts`
Expected: 3 passing.

- [ ] **Step 3: Start an isolated dev server**

Run: `cd apps/web && NEXT_DEV_ISOLATED=1 npx next dev -p 3007` (background)
Then compile the route: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3007/marketing/ads/autopilot` → expect `200`.

- [ ] **Step 4: Screenshot at native resolution (@2x)**

Open `http://localhost:3007/marketing/ads/autopilot` in the browser tool at deviceScaleFactor 2; screenshot the canvas. Verify: the canvas has non-zero height; the six nodes render (DE/IT markets → Moto/Helmets portfolios → AIREON/MISANO campaigns); edges are smooth anchored curves; health colors correct (MISANO red, Helmets amber); minimap + zoom controls present; light H10 look, no images.

- [ ] **Step 5: Present for sign-off**

Share the screenshot with the owner. If the canvas height is zero or layout is off, fix the flex/height chain in `mission-control.css` (`.mc-body`/`.mc-canvas-wrap`) and re-screenshot before claiming done. **Do not push** until the owner approves the fidelity (then push spec + P0 together).

---

## Self-Review

**1. Spec coverage (P0 scope):** Shared `<OpsCanvas>` on React Flow + light H10 ✓ (Tasks 2–3). Mission Control shell with header + canvas + inspector slot ✓ (Task 4). Real object nodes Market→Portfolio→Campaign with anchored edges, pan/zoom, minimap ✓ (Tasks 1–3, sample data Task 4). Native-screenshot fidelity sign-off ✓ (Task 5). Image-free + no new deps + attribution kept + AutopilotControlRoom preserved ✓ (Global Constraints, Task 4 note). Out of P0 scope (correctly deferred): real ontology API wiring (P1), expand/collapse interaction (P1), inspector content (P1), agents/actions (later arcs).

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every run step has an exact command + expected output. ✓

**3. Type consistency:** `OpsObject`/`OpsNodeData`/`OpsGraph` defined in Task 1 and consumed unchanged in Tasks 2–4. `buildGraph`, `COL_WIDTH`, `ROW_HEIGHT` names match across Task 1 (def) and Task 3 (use). `nodeTypes.object` ↔ `type: 'object'` on nodes match. `OpsCanvas({ objects })` signature matches Task 4 usage. ✓

---

## Execution Handoff

(filled in by the executor after owner approval)

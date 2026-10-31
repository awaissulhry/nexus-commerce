/**
 * The rules of `TraceTree` (B-W2b-09; design "TraceTree": quality.inspections, quality.holds, compliance.certificates,
 * compliance.tests, compliance.register, warehouse.lots, production.bundles; B-W2a-64 and -67 composed it) — pure, tested
 * in Node.
 *
 * A genealogy tree (lot → hides → cut pieces → bundles → work orders → garments → cartons → shipments → customers) the
 * person walks by keyboard (WAI-ARIA tree) and, when choosing the reach of a hold, a reversal or a recall, ticks by
 * branch: ticking a node ticks everything under it that may be ticked; a node is ticked when all of its tickable
 * descendants are, mixed when some are. A held node (cannot be ticked) keeps its state and says why.
 */
export interface TraceTreeNode {
  id: string
  children?: readonly TraceTreeNode[]
  /** May be ticked (default true when the tree takes a selection). */
  selectable?: boolean
  /** Why it cannot be ticked; null when it can. */
  held?: string | null
  /** The level's word ("Lot") — `traceLevels` counts by it. */
  kind?: string
  /** Only "may hold it". */
  possible?: boolean
}

export interface TraceRow<N extends TraceTreeNode = TraceTreeNode> {
  node: N
  depth: number
  parentId: string | null
  expandable: boolean
  expanded: boolean
  posInSet: number
  setSize: number
}

export type TraceKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End'
export const TRACE_KEYS: readonly TraceKey[] = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']

const kids = (node: TraceTreeNode): readonly TraceTreeNode[] => node.children ?? []

/** The rows shown with these nodes open, in reading order. */
export function traceRows<N extends TraceTreeNode>(roots: readonly N[], open: ReadonlySet<string>): TraceRow<N>[] {
  const rows: TraceRow<N>[] = []
  const walk = (items: readonly N[], depth: number, parentId: string | null) => {
    items.forEach((node, index) => {
      const expandable = kids(node).length > 0
      const expanded = expandable && open.has(node.id)
      rows.push({ node, depth, parentId, expandable, expanded, posInSet: index + 1, setSize: items.length })
      if (expanded) walk(kids(node) as readonly N[], depth + 1, node.id)
    })
  }
  walk(roots, 1, null)
  return rows
}

/** The nodes open at first: every node above `depth` (1 = only the roots' rows shown, closed). */
export function traceDefaultOpen(roots: readonly TraceTreeNode[], depth = 2): Set<string> {
  const open = new Set<string>()
  const walk = (items: readonly TraceTreeNode[], level: number) => {
    if (level >= depth) return
    for (const node of items) {
      if (kids(node).length > 0) {
        open.add(node.id)
        walk(kids(node), level + 1)
      }
    }
  }
  walk(roots, 1)
  return open
}

/**
 * What a key does on the focused row: ↓ / ↑ next / previous row; → opens a closed row or goes to its first child; ← closes
 * an open row or goes to its parent; Home / End the first / last row.
 */
export function traceMove(rows: readonly TraceRow[], focusId: string, key: TraceKey): { focus: string; toggle: string | null } {
  if (rows.length === 0) return { focus: focusId, toggle: null }
  const at = Math.max(0, rows.findIndex((row) => row.node.id === focusId))
  const row = rows[at]!
  switch (key) {
    case 'ArrowDown':
      return { focus: rows[Math.min(rows.length - 1, at + 1)]!.node.id, toggle: null }
    case 'ArrowUp':
      return { focus: rows[Math.max(0, at - 1)]!.node.id, toggle: null }
    case 'Home':
      return { focus: rows[0]!.node.id, toggle: null }
    case 'End':
      return { focus: rows[rows.length - 1]!.node.id, toggle: null }
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { focus: row.node.id, toggle: row.node.id }
      if (row.expanded) return { focus: rows[at + 1]?.node.id ?? row.node.id, toggle: null }
      return { focus: row.node.id, toggle: null }
    case 'ArrowLeft':
      if (row.expanded) return { focus: row.node.id, toggle: row.node.id }
      return { focus: row.parentId ?? row.node.id, toggle: null }
  }
}

const tickable = (node: TraceTreeNode): boolean => node.selectable !== false && !node.held

/** The ids a tick on `node` reaches: itself and every tickable node under it (held ones and their branches skipped). */
export function traceReach(node: TraceTreeNode): string[] {
  if (!tickable(node)) return []
  const out = [node.id]
  for (const child of kids(node)) out.push(...traceReach(child))
  return out
}

export type TraceCheck = 'checked' | 'mixed' | 'unchecked'

/** A node's box: all of its reach ticked, some, or none. A node with nothing to tick reads its own id only. */
export function traceCheck(node: TraceTreeNode, selected: ReadonlySet<string>): TraceCheck {
  const reach = traceReach(node)
  if (reach.length === 0) return selected.has(node.id) ? 'checked' : 'unchecked'
  const on = reach.filter((id) => selected.has(id)).length
  return on === 0 ? 'unchecked' : on === reach.length ? 'checked' : 'mixed'
}

/** The selection after a tick on `node`: a fully ticked branch is cleared, otherwise all of it is ticked. */
export function traceToggle(node: TraceTreeNode, selected: readonly string[]): string[] {
  const reach = traceReach(node)
  if (reach.length === 0) return [...selected]
  const set = new Set(selected)
  if (traceCheck(node, set) === 'checked') for (const id of reach) set.delete(id)
  else for (const id of reach) set.add(id)
  return [...set]
}

export function traceFind<N extends TraceTreeNode>(roots: readonly N[], id: string): N | null {
  for (const node of roots) {
    if (node.id === id) return node
    const found = traceFind(kids(node) as readonly N[], id)
    if (found) return found
  }
  return null
}

export interface TraceLevelCount {
  id: string
  /** Nodes of this kind that hold the item. */
  count: number
  /** Nodes of this kind that only may hold it. */
  possible: number
}

/** Nodes per `kind`, in the order kinds first appear (depth first): exact and "may hold it" apart. */
export function traceLevels(roots: readonly TraceTreeNode[]): TraceLevelCount[] {
  const order: string[] = []
  const counts = new Map<string, TraceLevelCount>()
  const walk = (items: readonly TraceTreeNode[]) => {
    for (const node of items) {
      if (node.kind) {
        let entry = counts.get(node.kind)
        if (!entry) {
          entry = { id: node.kind, count: 0, possible: 0 }
          counts.set(node.kind, entry)
          order.push(node.kind)
        }
        if (node.possible) entry.possible += 1
        else entry.count += 1
      }
      walk(kids(node))
    }
  }
  walk(roots)
  return order.map((kind) => counts.get(kind)!)
}

import { TRACE_NODE_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import type { NodeKind, StartKind, Trace, TraceFind, TraceNode } from '../../stock/daily/api'

/**
 * The trace tree (B-W2a-64; design warehouse.lots lt-trace-tree "TraceTree (new)", composed here: the DS has none), pure:
 * the API's graph (B-W2a-27: nodes, edges upstream → downstream, levels, gaps) as ONE tree under the start — "Came
 * from" walks the edges backward (a node's parents), "Went to" forward (its children). A DAG becomes a tree by a
 * breadth-first walk: each node hangs under the first node that reaches it (a bundle under the hide that was cut for it
 * before its cell). More than GROUP_LIMIT children of one kind are counted first in a group the reader opens (a large
 * trace loads level by level). "Show only affected customers" keeps, on the forward side, the branches that reach a
 * customer who received the goods. Where each node opens, the trace dialog's outcome and the address of the trace page.
 */

export const GROUP_LIMIT = 12
/** The DS TraceTree's open depth: the start and its two sides open at first; the levels under them stay counted, closed. */
export const TRACE_OPEN_DEPTH = 3
const KIND_ORDER = new Map<string, number>(TRACE_NODE_KINDS.map((kind, index) => [kind, index]))

export type TreeSide = 'BACKWARD' | 'FORWARD'
export interface EdgeFacts {
  readonly link: Trace['edges'][number]['link']
  readonly exact: boolean
  readonly quantity: string | null
  readonly uom: string | null
}

export type TreeItem =
  | { readonly type: 'node'; readonly id: string; readonly node: TraceNode; readonly edge: EdgeFacts | null; readonly children: readonly TreeItem[] }
  | { readonly type: 'section'; readonly id: string; readonly side: TreeSide; readonly count: number; readonly children: readonly TreeItem[] }
  | { readonly type: 'group'; readonly id: string; readonly kind: NodeKind; readonly exact: number; readonly possible: number; readonly children: readonly TreeItem[] }

const byKindThenCode = (a: TraceNode, b: TraceNode) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || (a.code ?? '').localeCompare(b.code ?? '')

/** One side of the start as a tree: breadth first, each node once, under the first node that reaches it. */
function sideTree(trace: Trace, side: TreeSide, nodes: ReadonlyMap<string, TraceNode>): TreeItem[] {
  const next = new Map<string, { key: string; edge: EdgeFacts }[]>()
  for (const edge of trace.edges) {
    const [from, to] = side === 'FORWARD' ? [edge.from, edge.to] : [edge.to, edge.from]
    const list = next.get(from) ?? []
    list.push({ key: to, edge: { link: edge.link, exact: edge.exact, quantity: edge.quantity, uom: edge.uom } })
    next.set(from, list)
  }
  const placed = new Set<string>([trace.start.key])
  const childrenOf = new Map<string, { node: TraceNode; edge: EdgeFacts }[]>()
  let frontier = [trace.start.key]
  while (frontier.length > 0) {
    const reached: string[] = []
    for (const key of frontier) {
      const found: { node: TraceNode; edge: EdgeFacts }[] = []
      for (const step of next.get(key) ?? []) {
        const node = nodes.get(step.key)
        if (!node || placed.has(step.key) || !node.sides.includes(side)) continue
        placed.add(step.key)
        found.push({ node, edge: step.edge })
        reached.push(step.key)
      }
      found.sort((a, b) => byKindThenCode(a.node, b.node))
      childrenOf.set(key, found)
    }
    frontier = reached
  }
  const build = (key: string, path: string): TreeItem[] => {
    const found = childrenOf.get(key) ?? []
    const items: TreeItem[] = []
    const kinds = [...new Set(found.map((entry) => entry.node.kind))]
    for (const kind of kinds) {
      const ofKind = found.filter((entry) => entry.node.kind === kind)
      const nodesOfKind = ofKind.map((entry) => ({ type: 'node' as const, id: `${path}>${entry.node.key}`, node: entry.node, edge: entry.edge, children: build(entry.node.key, `${path}>${entry.node.key}`) }))
      if (ofKind.length > GROUP_LIMIT)
        items.push({
          type: 'group',
          id: `${path}>group:${kind}`,
          kind,
          exact: ofKind.filter((entry) => entry.node.reach === 'EXACT').length,
          possible: ofKind.filter((entry) => entry.node.reach === 'POSSIBLE').length,
          children: nodesOfKind,
        })
      else items.push(...nodesOfKind)
    }
    return items
  }
  return build(trace.start.key, side)
}

/** Every node of a subtree (a section's count). */
export function countNodes(items: readonly TreeItem[]): number {
  return items.reduce((sum, item) => sum + (item.type === 'node' ? 1 : 0) + countNodes(item.children), 0)
}

/** The trace as one tree: the start, "Came from" and "Went to" (only the sides asked; an empty side is left out). */
export function traceTree(trace: Trace): TreeItem | null {
  const nodes = new Map(trace.nodes.map((node) => [node.key, node]))
  const start = nodes.get(trace.start.key)
  if (!start) return null
  const sections: TreeItem[] = []
  for (const side of ['BACKWARD', 'FORWARD'] as const) {
    if (trace.direction !== 'BOTH' && trace.direction !== side) continue
    const children = sideTree(trace, side, nodes)
    sections.push({ type: 'section', id: `section:${side}`, side, count: countNodes(children), children })
  }
  return { type: 'node', id: 'start', node: start, edge: null, children: sections }
}

/** A customer who received the goods (one of its shipments carrying them left the site). */
const affected = (node: TraceNode) => node.kind === 'CUSTOMER' && node.received === true

/** "Show only affected customers": the forward side keeps the branches that reach a customer who received the goods. */
export function onlyAffected(root: TreeItem): TreeItem {
  const keep = (item: TreeItem): TreeItem | null => {
    if (item.type === 'node' && affected(item.node)) return item
    const children = item.children.map(keep).filter((child): child is TreeItem => child !== null)
    if (children.length === 0) return null
    return { ...item, children } as TreeItem
  }
  return {
    ...root,
    children: root.children.map((section) => {
      if (section.type !== 'section' || section.side !== 'FORWARD') return section
      const children = section.children.map(keep).filter((child): child is TreeItem => child !== null)
      return { ...section, count: countNodes(children), children }
    }),
  } as TreeItem
}

// ---- where a node opens ---------------------------------------------------------------------------------------------------

/** A record a node opens (the record-links type and id, and a tab), or null: a node without a page (restricted, a party not shown). */
export function nodeRecord(node: TraceNode): { type: string; id: string; tab?: string } | null {
  if (node.restricted.length > 0 && node.code === null) return null
  switch (node.kind) {
    case 'LOT':
      return { type: 'Lot', id: node.id }
    case 'HIDE':
      return { type: 'Hide', id: node.id }
    case 'WORK_ORDER':
      return { type: 'WorkOrder', id: node.id }
    case 'CELL':
      return node.cell ? { type: 'WorkOrder', id: node.cell.workOrderId } : null
    case 'BUNDLE':
      return node.bundle ? { type: 'WorkOrder', id: node.bundle.workOrderId, tab: 'bundles' } : null
    case 'SERIAL':
      return node.serial ? { type: 'WorkOrder', id: node.serial.workOrderId } : null
    case 'SHIPMENT':
      return { type: 'Shipment', id: node.id }
    case 'RECEIPT':
      return { type: 'GoodsReceipt', id: node.id }
    case 'SUBCONTRACT':
      return { type: 'SubcontractOrder', id: node.id }
    case 'SUPPLIER':
    case 'CUSTOMER':
      return node.party ? { type: 'Party', id: node.party.id } : null
  }
}

/** The gap's place in words: the code of the node it names (else "—"). */
export const gapPlace = (trace: Trace, at: string): string => trace.nodes.find((node) => node.key === at)?.code ?? '—'

export const GAP_TONE = { BROKEN: 'danger', COARSE: 'warning', IN_WORK: 'info' } as const

// ---- the trace dialog and the trace page -----------------------------------------------------------------------------------

/** Where a traced record opens: a lot on its record's Trace tab, anything else on the trace page. */
export function traceHref(prefix: string, match: { kind: StartKind; id: string }): string {
  if (match.kind === 'LOT') return `${prefix}/warehouse/lots/${encodeURIComponent(match.id)}?tab=trace`
  return `${prefix}/warehouse/lots/trace?kind=${encodeURIComponent(match.kind)}&id=${encodeURIComponent(match.id)}`
}

export type FindState = 'idle' | 'finding' | 'several' | 'none' | 'unreadable' | 'error'

export interface TraceFindModel {
  code: string
  state: FindState
  matches: TraceFind['matches']
  /** The failed read in words (a key of `stock`). */
  problem: string | null
}
export const blankFind = (): TraceFindModel => ({ code: '', state: 'idle', matches: [], problem: null })

/** What the dialog does with an answer: open the one match, let the person pick, or say nothing was found (and why). */
export function findOutcome(answer: TraceFind): { open: TraceFind['matches'][number] | null; state: FindState } {
  if (answer.matches.length === 1) return { open: answer.matches[0]!, state: 'idle' }
  if (answer.matches.length > 1) return { open: null, state: 'several' }
  return { open: null, state: answer.problem ? 'unreadable' : 'none' }
}

/** The trace page's address terms (`?kind=&id=&direction=`); null when they name nothing traceable. */
export function traceAddressOf(params: { get(name: string): string | null } | null): { kind: StartKind; id: string; direction: 'BACKWARD' | 'FORWARD' | 'BOTH' } | null {
  const kind = params?.get('kind') ?? ''
  const id = params?.get('id') ?? ''
  const direction = params?.get('direction')
  if (!['LOT', 'HIDE', 'BUNDLE', 'WORK_ORDER', 'SERIAL', 'SHIPMENT'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id)) return null
  return { kind: kind as StartKind, id, direction: direction === 'BACKWARD' || direction === 'FORWARD' ? direction : 'BOTH' }
}

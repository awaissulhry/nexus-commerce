'use client'

/**
 * TraceTree — a genealogy impact tree (B-W2b-09; design "TraceTree": lot → hides → cut pieces → bundles → work orders →
 * garments → cartons → shipments → customers), with the counts per level, "may hold it" for what the records link only
 * coarsely, and — when the reach of a hold, a reversal, a recall or a suspension is being chosen — tickable branches.
 *
 *   <TraceTree label="Trace of lot L-0042" roots={[lotNode]} levels={levels} before={<Banner …>gaps</Banner>}
 *     selection={{ selected: reach, onChange: setReach }} labels={ds.traceTree} />
 *
 * - **Keyboard** (WAI-ARIA tree, one Tab stop): ↑ ↓ move, → opens or goes in, ← closes or goes out, Home / End; Enter
 *   follows the node's link (its record) or opens / closes it; Space ticks the branch when the tree takes a selection,
 *   else opens / closes. The keys live in ONE information icon under the tree (Owner rule 2026-10-29).
 * - **Ticking a branch**: a tick reaches the node and everything under it that may be ticked; a parent shows ticked,
 *   mixed or not (`aria-checked`); a held node keeps its state and says why. The app shows the reach ("12 selected")
 *   before the action's click and sends the ids.
 * - **Honest counts**: `levels` say exact counts and, apart, how many only may hold it (`traceLevels` counts a tree).
 * - Data in, events out: no reads. A node's `href` is a real link (`linkAs`).
 * Its own entry point (`patterns/trace-tree`). Every word from `labels` or the app.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import NextLink from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { InfoTip } from '../../primitives/InfoTip'
import { Tag } from '../../primitives/Tag'
import { mergeLabels } from '../../lib/labels'
import { TRACE_TREE_LABELS, type TraceTreeLabels } from './TraceTreeLabels'
import { TRACE_KEYS, traceCheck, traceDefaultOpen, traceMove, traceRows, traceToggle, type TraceKey, type TraceTreeNode } from './traceTreeModel'
import './trace-tree.css'

export interface TraceNode extends TraceTreeNode {
  /** The node's code or name ("L-0042"). Also its text name. */
  label: string
  /** The level's word before the code ("Lot"). */
  kind?: string
  /** The node's record (a real link). */
  href?: string | null
  /** After the label: the quantity, a state pill. */
  meta?: ReactNode
  /** A line under it (a hold's reason). */
  note?: ReactNode
  children?: readonly TraceNode[]
}

export interface TraceLevel {
  id: string
  /** "12 garments" — the count in the person's words. */
  label: string
  /** How many of them only may hold it (said apart). */
  possible?: number
}

export type TraceTreeLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode; tabIndex?: number }>

export interface TraceTreeProps {
  roots: readonly TraceNode[]
  /** The tree's name: "Trace of lot L-0042". */
  label: string
  /** The counts per level, above the tree. */
  levels?: readonly TraceLevel[]
  /** Between the levels and the tree: the gaps of the chain, what the reader may not see, the app's filters. */
  before?: ReactNode
  /** Nodes open at first (uncontrolled): everything above this depth. Default 2. */
  defaultOpenDepth?: number
  /** Tickable branches (the reach of an action). */
  selection?: { selected: readonly string[]; onChange: (ids: string[]) => void }
  /** Shown in place of the tree when there are no roots. */
  empty?: ReactNode
  linkAs?: TraceTreeLinkComponent
  labels?: Partial<TraceTreeLabels>
  className?: string
}

export function TraceTree({ roots, label, levels, before, defaultOpenDepth = 2, selection, empty, linkAs, labels, className }: TraceTreeProps) {
  const words = mergeLabels(TRACE_TREE_LABELS, labels)
  const [open, setOpen] = useState<Set<string>>(() => traceDefaultOpen(roots, defaultOpenDepth))
  const rootKey = roots.map((root) => root.id).join('|')
  // A new tree (other roots) opens at its default depth again; the same tree keeps what the person opened.
  useEffect(() => setOpen(traceDefaultOpen(roots, defaultOpenDepth)), [rootKey, defaultOpenDepth])
  const rows = useMemo(() => traceRows(roots, open), [roots, open])
  const [focus, setFocus] = useState<string>(roots[0]?.id ?? '')
  const refs = useRef(new Map<string, HTMLDivElement>())
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    refs.current.get(focus)?.focus()
  }, [focus, rows])
  const selected = useMemo(() => new Set(selection?.selected ?? []), [selection?.selected])
  const Link = linkAs ?? NextLink

  const toggleOpen = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const tick = (node: TraceNode) => {
    if (!selection || node.held || node.selectable === false) return
    selection.onChange(traceToggle(node, selection.selected))
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>, node: TraceNode, expandable: boolean) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Enter') {
      const link = refs.current.get(node.id)?.querySelector<HTMLAnchorElement>('a[href]')
      if (link) {
        event.preventDefault()
        link.click()
      } else if (expandable) {
        event.preventDefault()
        toggleOpen(node.id)
      }
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      if (selection) tick(node)
      else if (expandable) toggleOpen(node.id)
      return
    }
    if (!(TRACE_KEYS as readonly string[]).includes(event.key)) return
    event.preventDefault()
    const step = traceMove(rows, node.id, event.key as TraceKey)
    if (step.toggle) toggleOpen(step.toggle)
    moved.current = true
    setFocus(step.focus)
  }

  const focusable = rows.some((row) => row.node.id === focus) ? focus : (rows[0]?.node.id ?? '')
  const cls = ['nds-tracetree', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      {levels && levels.length > 0 && (
        <ul className="nds-tracetree-levels" aria-label={words.levels}>
          {levels.map((level) => (
            <li key={level.id}>
              <Tag tone="neutral">{level.label}</Tag>
              {level.possible ? <span className="nds-tracetree-sub">{words.possibleCount(level.possible)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {before}
      {selection && (
        <p className="nds-tracetree-count" role="status" aria-live="polite">
          {words.selected(selection.selected.length)}
        </p>
      )}
      {roots.length === 0 ? (
        <div className="nds-tracetree-empty">{empty ?? words.empty}</div>
      ) : (
        <div className="nds-tracetree-tree" role="tree" aria-label={label}>
          {rows.map((row) => {
            const node = row.node
            const check = selection ? traceCheck(node, selected) : null
            return (
              <div
                key={node.id}
                ref={(element) => {
                  if (element) refs.current.set(node.id, element)
                  else refs.current.delete(node.id)
                }}
                className={`nds-tracetree-row${node.possible ? ' is-possible' : ''}${check === 'checked' ? ' is-checked' : ''}`}
                role="treeitem"
                aria-level={row.depth}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-checked={check === null ? undefined : check === 'mixed' ? 'mixed' : check === 'checked'}
                aria-description={node.held ?? undefined}
                tabIndex={node.id === focusable ? 0 : -1}
                style={{ ['--nds-tt-depth' as string]: row.depth - 1 }}
                onFocus={() => setFocus(node.id)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('a, .nds-tracetree-box')) return
                  setFocus(node.id)
                  if (row.expandable) toggleOpen(node.id)
                }}
                onKeyDown={(event) => onKey(event, node, row.expandable)}
              >
                <span className="nds-tracetree-chevron" aria-hidden>
                  {row.expandable ? row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                </span>
                {selection && (
                  <input
                    type="checkbox"
                    className="nds-tracetree-box"
                    aria-hidden
                    tabIndex={-1}
                    checked={check === 'checked'}
                    ref={(box) => {
                      if (box) box.indeterminate = check === 'mixed'
                    }}
                    title={node.held ?? words.tick(node.kind ? `${node.kind} ${node.label}` : node.label)}
                    onChange={() => tick(node)}
                  />
                )}
                <span className="nds-tracetree-main">
                  {node.kind && <span className="nds-tracetree-kind">{node.kind}</span>}
                  {node.href ? (
                    <Link className="nds-tracetree-link" href={node.href} tabIndex={-1}>
                      {node.label}
                    </Link>
                  ) : (
                    <span className="nds-tracetree-label">{node.label}</span>
                  )}
                  {node.possible && <span className="nds-tracetree-possible">{words.possible}</span>}
                  {node.meta != null && <span className="nds-tracetree-meta">{node.meta}</span>}
                </span>
                {(node.note != null || node.held) && <span className="nds-tracetree-note">{node.note ?? node.held}</span>}
              </div>
            )
          })}
        </div>
      )}
      {/* The tree's keys in ONE information icon under it (Owner rule 2026-10-29: never key hints above a list). */}
      {roots.length > 0 && (
        <div className="nds-tracetree-foot">
          <InfoTip tip={words.keys} />
        </div>
      )}
    </div>
  )
}

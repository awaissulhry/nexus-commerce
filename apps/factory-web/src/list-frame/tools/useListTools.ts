'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ColDef } from '@nexus/ui/grid'
import { roleDefaultFor } from '@nexus/factory-domain/views/rules'
import { applyLayout, cleanLayout, screenState, showsView, toolColumnsOf, type ToolColumn } from './model'
import { problemOf, useListToolsTransport, type ListToolsTransport, type SavedView, type ToolsProblem, type ViewsAnswer, type WorkingLayout } from './transport'

/**
 * The list tools' state, held by the ONE list frame (B-W2a-23; PLT-163): which list this is, the person's views of it,
 * the layout on screen (the working one, kept in this browser per list; or the view's), the view it opened, and the
 * columns the grid draws with that layout. The menus and dialogs (ListToolsBar) act on it.
 *
 * The list key: the frame's own (`listKey`), else the page's (the Office address with dots) for the page's first
 * frame and `<page>.<n>` for the n-th (two lists on one page keep their views apart). A record page has none: its
 * tabs' lists keep their own toolbar. Opening: a shared link's `?savedView=` first; else, on a clean address with no
 * working layout, my own default view of the list (B-W2b-24), else the default view of the first role the person holds
 * that has one.
 */

export interface ListToolsArgs<T> {
  readonly frame: RefObject<HTMLDivElement | null>
  /** The frame's own key; null: no tools; undefined: the page's. */
  readonly listKey: string | null | undefined
  readonly columns: ColDef<T>[]
  /** The list's name (the export file is named after it). */
  readonly title: string
}

export interface ListToolsState<T> {
  readonly transport: ListToolsTransport | null
  readonly listKey: string | null
  /** The frame's columns with the layout on screen. */
  readonly columns: ColDef<T>[]
  readonly tools: readonly ToolColumn[]
  readonly title: string
  readonly answer: ViewsAnswer | null
  readonly problem: ToolsProblem | null
  readonly layout: WorkingLayout
  /** The view the screen opened (null: the list as built); `changed` once the screen differs from it. */
  readonly active: SavedView | null
  readonly changed: boolean
  /** A shared link named a view this person cannot open. */
  readonly linkNotice: boolean
  reload(): void
  /** Opens a view (its terms in the address, its layout on the grid); null: the columns as built. */
  apply(view: SavedView | null): void
  setLayout(next: WorkingLayout): void
  /** A view was made or changed: in the menu, and the one on screen. */
  saved(view: SavedView): void
  /** B-W2b-24: my default view changed (the view as it is now, and the list's default for me). */
  defaulted(view: SavedView, personalDefaultId: string | null): void
  removed(viewId: string): void
  dismissLinkNotice(): void
}

const EMPTY: WorkingLayout = Object.freeze({})

export function useListTools<T>({ frame, listKey: own, columns, title }: ListToolsArgs<T>): ListToolsState<T> {
  const transport = useListToolsTransport()
  const [index, setIndex] = useState<number | null>(null)
  useEffect(() => {
    if (!frame.current) return
    setIndex(Array.from(document.querySelectorAll('.fw-list')).indexOf(frame.current))
  }, [frame])
  const pageKey = transport?.pageKey ?? null
  const listKey = !transport ? null : own !== undefined ? own : pageKey && index !== null && index >= 0 ? (index === 0 ? pageKey : `${pageKey}.${index + 1}`) : null

  const [answer, setAnswer] = useState<ViewsAnswer | null>(null)
  const [problem, setProblem] = useState<ToolsProblem | null>(null)
  const [layout, setLayoutState] = useState<WorkingLayout>(EMPTY)
  const [linkNotice, setLinkNotice] = useState(false)
  const opened = useRef<string | null>(null)
  const latest = useRef(transport)
  latest.current = transport

  // The working layout of this list in this browser.
  useEffect(() => {
    setLayoutState(listKey && transport ? (transport.readLayout(listKey) ?? (transport.design?.activeViewId ? { viewId: transport.design.activeViewId } : EMPTY)) : EMPTY)
    // Once per list.
  }, [listKey])

  const setLayout = useCallback(
    (next: WorkingLayout) => {
      setLayoutState(next)
      if (listKey) latest.current?.writeLayout(listKey, next.columns || next.density || next.viewId ? next : null)
    },
    [listKey],
  )

  const apply = useCallback(
    (view: SavedView | null) => {
      const current = latest.current
      if (!current || !listKey) return
      if (view === null) {
        setLayout({})
        return
      }
      setLayout({ columns: view.state.columns, density: view.state.density, viewId: view.id })
      if (view.state.query !== current.query || current.linked.view) current.goTo(view.state.query)
    },
    [listKey, setLayout],
  )

  const load = useCallback(() => {
    const current = latest.current
    if (!current || !listKey) return
    setProblem(null)
    current
      .listViews(listKey)
      .then((next) => {
        setAnswer(next)
        if (opened.current === listKey) return
        opened.current = listKey
        // A shared link names a view: open it when it is one of this person's views of the list (every view they may
        // see is in the answer), else say it cannot be opened.
        const linked = current.linked.view
        if (linked) {
          const found = next.views.find((view) => view.id === linked)
          if (found) apply(found)
          else {
            setLinkNotice(true)
            current.clearLinked()
          }
          return
        }
        // A clean address and no working layout: my own default view (B-W2b-24), else the role's default view.
        const stored = current.readLayout(listKey)
        if (current.query === '' && !stored) {
          const mine = next.personalDefaultId ? next.views.find((entry) => entry.id === next.personalDefaultId && entry.mine) : undefined
          const fallback = mine ? null : roleDefaultFor(next.views, { userId: '', roleIds: next.roles.map((role) => role.id), save: false, manage: false })
          const view = mine ?? (fallback ? next.views.find((entry) => entry.id === fallback.id) : undefined)
          if (view) apply(view)
        }
      })
      .catch((error: unknown) => {
        setAnswer(null)
        setProblem(problemOf(error))
      })
  }, [listKey, apply])

  useEffect(() => {
    setAnswer(null)
    if (listKey && transport) load()
    // Once per list (reload() for the rest).
  }, [listKey])

  const tools = useMemo(() => toolColumnsOf(columns as ColDef<unknown>[]), [columns])
  const shown = useMemo(() => applyLayout(columns, cleanLayout(layout.columns, tools)), [columns, layout.columns, tools])
  const active = useMemo(() => (layout.viewId && answer ? (answer.views.find((view) => view.id === layout.viewId) ?? null) : null), [layout.viewId, answer])
  const changed = active !== null && transport !== null && !showsView(active, transport.query, layout)

  const saved = useCallback(
    (view: SavedView) => {
      setAnswer((current) => (current ? { ...current, views: [...current.views.filter((entry) => entry.id !== view.id), view] } : current))
      setLayout({ columns: view.state.columns, density: view.state.density, viewId: view.id })
    },
    [setLayout],
  )
  const defaulted = useCallback((view: SavedView, personalDefaultId: string | null) => {
    setAnswer((current) =>
      current
        ? {
            ...current,
            personalDefaultId,
            views: current.views.map((entry) => (entry.id === view.id ? view : personalDefaultId !== null && entry.personalDefault ? { ...entry, personalDefault: false, version: entry.version + 1 } : entry)),
          }
        : current,
    )
  }, [])
  const removed = useCallback(
    (viewId: string) => {
      setAnswer((current) => (current ? { ...current, views: current.views.filter((entry) => entry.id !== viewId), personalDefaultId: current.personalDefaultId === viewId ? null : current.personalDefaultId } : current))
      if (layout.viewId === viewId) setLayout({ ...layout, viewId: null })
    },
    [layout, setLayout],
  )

  return {
    transport: listKey ? transport : null,
    listKey,
    columns: shown,
    tools,
    title,
    answer,
    problem,
    layout,
    active,
    changed,
    linkNotice,
    reload: load,
    apply,
    setLayout,
    saved,
    defaulted,
    removed,
    dismissLinkNotice: () => setLinkNotice(false),
  }
}

/** What a new view of the screen keeps. */
export const stateOfScreen = <T,>(state: ListToolsState<T>) => screenState(state.transport?.query ?? '', state.layout)

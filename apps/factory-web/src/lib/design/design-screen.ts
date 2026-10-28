import type { ComponentType, ReactNode } from 'react'

/**
 * Design = real screens with made-up data (PLAN §3.1). Each screen is a view component that takes ONE typed view model,
 * and a `fixtures.ts` beside its `view/` folder exports `designScreen = defineDesignScreen({...})`: the screen's SCR id,
 * its view and its cases (empty, normal, many rows, error, read-only — whichever the screen has).
 *
 * The local-only `/design` index (src/app/design) finds every `fixtures.ts` under `src/` by itself, so a design batch
 * adds files and never edits the index. Fixture data is made up: never a real customer, supplier, person or number.
 */

export type ScreenId = `SCR-${string}`

export interface DesignCase<M> {
  /** Unique in the screen; part of the frame's address (`/design/SCR-003/normal`). */
  id: string
  label: string
  model: M
  /** What this case shows, for the reviewer. */
  note?: string
}

export interface DesignScreen<M> {
  screen: ScreenId
  title: string
  view: ComponentType<{ model: M; children?: ReactNode }>
  cases: readonly DesignCase<M>[]
  /** The view holds a page (the office shell): the design frame puts a sample page inside it. */
  holdsPage?: boolean
  /** A part of a screen (a top-bar control): the design frame gives it room around it. */
  part?: boolean
}

export function defineDesignScreen<M>(screen: DesignScreen<M>): DesignScreen<M> {
  const ids = new Set<string>()
  for (const item of screen.cases) {
    if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error(`${screen.screen}: case id "${item.id}" is not lower-case-with-hyphens`)
    if (ids.has(item.id)) throw new Error(`${screen.screen}: case id "${item.id}" twice`)
    ids.add(item.id)
  }
  return screen
}

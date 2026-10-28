import type { DesignCase, DesignScreen } from '../../lib/design/design-screen'

/**
 * Every screen with design fixtures, found by itself: each `fixtures.ts` under `src/` that exports `designScreen`
 * (lib/design/design-screen.ts). A design batch adds its files and never edits this index (PLAN §3.1). Local only: this
 * folder's routes exist only under `next dev` (src/lib/design/route.ts, check-no-design-route.mjs).
 */

export interface FoundScreen extends DesignScreen<unknown> {
  /** Where its fixtures live, from `src/`. */
  file: string
}

const FOUND = import.meta.glob('./**/fixtures.ts', { base: '../../', eager: true, import: 'designScreen' }) as Record<string, DesignScreen<unknown> | undefined>

const bySid = (a: FoundScreen, b: FoundScreen) => a.screen.localeCompare(b.screen, 'en', { numeric: true })

export function designScreens(found: Readonly<Record<string, DesignScreen<unknown> | undefined>> = FOUND): FoundScreen[] {
  return Object.entries(found)
    .flatMap(([path, screen]) => (screen ? [{ ...screen, file: path.replace(/^(\.{1,2}\/)+/, '') }] : []))
    .sort(bySid)
}

export const DESIGN_SCREENS: readonly FoundScreen[] = designScreens()

export function findScreen(id: string): FoundScreen | undefined {
  return DESIGN_SCREENS.find((screen) => screen.screen === id)
}

export function findCase(screen: FoundScreen, id: string): DesignCase<unknown> | undefined {
  return screen.cases.find((item) => item.id === id)
}

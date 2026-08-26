'use client'

/**
 * GX.7 — the wiring every arrangeable tab needs, in one place.
 *
 * Four tabs now let you reorder, resize and switch panels off. Written out per tab that is four
 * copies of the same six lines, and four chances for them to drift into four slightly different
 * behaviours — which is the precise inconsistency the section pattern exists to remove. The hook
 * owns the state, the mount-time read and the controls; a tab supplies its catalogue and renders
 * `<SectionLayout>` with the pieces.
 *
 * The controls come back as a node rather than a component so the tab drops them into the
 * provenance strip's `actions` slot, where every other tab-level control already lives.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  defaultSectionLayout, readSectionLayout, writeSectionLayout,
  type SectionLayoutValue, type SectionSpec,
} from '@/design-system/patterns/SectionLayout'
import { SectionControls } from './SectionControls'

export interface SectionsHandle {
  /** True while the width steps are showing. Pass to `<SectionLayout editing>`. */
  arranging: boolean
  /** The layout. `SectionLayout` is controlled, so this is the one copy that exists. */
  layout: SectionLayoutValue
  /** Every change goes through here, which is also the only place it is written to storage. */
  setLayout: (v: SectionLayoutValue) => void
  /** Sections + Arrange, for the provenance strip's `actions` slot. */
  controls: ReactNode
}

export function useSections(sections: readonly SectionSpec[], storageKey: string): SectionsHandle {
  const [arranging, setArranging] = useState(false)
  const [layout, setLayoutState] = useState<SectionLayoutValue>(() => defaultSectionLayout(sections))

  // After mount, never in the initializer: the initializer runs during render, where there is no
  // localStorage on the server. `sections` is a module constant in every caller, so the key alone
  // is the right dependency — listing it would re-read on every render for no gain.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLayoutState(readSectionLayout(storageKey, sections)) }, [storageKey])

  /**
   * ONE writer. The dialog and the width steps both land here, so there is no path that updates
   * the screen without persisting, or persists without updating the screen — which is exactly the
   * defect that made the Sections dialog appear to do nothing until the page was reloaded.
   */
  const setLayout = useCallback((next: SectionLayoutValue) => {
    setLayoutState(next)
    writeSectionLayout(storageKey, next)
  }, [storageKey])

  return {
    arranging,
    layout,
    setLayout,
    controls: (
      <SectionControls
        sections={sections}
        value={layout}
        onChange={setLayout}
        arranging={arranging}
        onArrangingChange={setArranging}
      />
    ),
  }
}

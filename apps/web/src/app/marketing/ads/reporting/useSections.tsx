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
import { useEffect, useState, type ReactNode } from 'react'
import {
  defaultSectionLayout, readSectionLayout,
  type SectionLayoutValue, type SectionSpec,
} from '@/design-system/patterns/SectionLayout'
import { SectionControls } from './SectionControls'

export interface SectionsHandle {
  /** True while the width steps are showing. Pass to `<SectionLayout editing>`. */
  arranging: boolean
  layout: SectionLayoutValue
  /** Sections + Arrange, for the provenance strip's `actions` slot. */
  controls: ReactNode
}

export function useSections(sections: readonly SectionSpec[], storageKey: string): SectionsHandle {
  const [arranging, setArranging] = useState(false)
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(sections))

  // After mount, never in the initializer: the initializer runs during render, where there is no
  // localStorage on the server. `sections` is a module constant in every caller, so the key alone
  // is the right dependency — listing it would re-read on every render for no gain.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLayout(readSectionLayout(storageKey, sections)) }, [storageKey])

  return {
    arranging,
    layout,
    controls: (
      <SectionControls
        sections={sections}
        storageKey={storageKey}
        value={layout}
        onChange={setLayout}
        arranging={arranging}
        onArrangingChange={setArranging}
      />
    ),
  }
}

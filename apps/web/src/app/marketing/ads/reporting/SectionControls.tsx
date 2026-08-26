'use client'

/**
 * GX.6 — the two controls a rearrangeable tab needs, and nothing more.
 *
 * "Sections" opens the platform's ONE Customize dialog for order and visibility. "Arrange" turns
 * on the width steps, which live on the sections themselves because you are choosing how a panel
 * sits against the ones beside it — a judgement you cannot make from inside a modal.
 *
 * `PreferencesModal` is reused exactly as the grids use it, with no change to it at all: the
 * sections go in as `allColumns`, and `visibleColumns` comes back holding both the set and the
 * order. Its left panel collapses on its own when every option list is empty, so the dialog opens
 * showing just the list — sections have no page size, no sticky column and no sort.
 */
import { useCallback, useMemo, useState } from 'react'
import { LayoutGrid, Settings2 } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { PreferencesModal } from '@/design-system/patterns/PreferencesModal'
import {
  defaultSectionLayout,
  type SectionLayoutValue, type SectionSpec,
} from '@/design-system/patterns/SectionLayout'

export function SectionControls({
  sections, value, onChange, arranging, onArrangingChange,
}: {
  sections: readonly SectionSpec[]
  value: SectionLayoutValue
  onChange: (v: SectionLayoutValue) => void
  arranging: boolean
  onArrangingChange: (v: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  const allColumns = useMemo(
    () => sections.map((s) => ({ key: s.id, label: s.label, locked: s.locked })),
    [sections],
  )
  const defaults = useMemo(() => defaultSectionLayout(sections), [sections])

  const onConfirm = useCallback((next: { visibleColumns: string[] }) => {
    // The dialog returns the ORDER as well as the set, and it must be honoured — a drag handle
    // that did not move anything would be a control that lies.
    //
    // `onChange` is the page's single writer: it sets the state the layout renders from AND
    // persists it. This used to also call `writeSectionLayout` itself, which stored the choice
    // while the mounted layout carried on rendering its own stale copy — the dialog saved, closed,
    // and nothing moved until the next reload.
    onChange({ order: next.visibleColumns, widths: value.widths })
    setOpen(false)
  }, [value.widths, onChange])

  return (
    <>
      <span className="rpx-sectionctl">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Settings2 size={13} aria-hidden /> Sections
        </Button>
        <Button size="sm" active={arranging} onClick={() => onArrangingChange(!arranging)}>
          <LayoutGrid size={13} aria-hidden /> {arranging ? 'Done' : 'Arrange'}
        </Button>
      </span>

      <PreferencesModal
        open={open}
        onClose={() => setOpen(false)}
        title="Sections on this tab"
        value={{
          visibleColumns: value.order,
          // Inert here, and the dialog hides every control that owns them (below).
          stickyFirstColumn: true, stickyLastColumn: true, pageSize: 100, sortBy: '', sortDir: 'desc',
        }}
        onConfirm={onConfirm}
        allColumns={allColumns}
        defaultVisible={defaults.order}
        // A section has no page size, no sticky column and no sort. Passing empty lists collapses
        // those parts of the dialog rather than showing controls that would do nothing.
        pageSizeChoices={[]}
        sortFieldOptions={[]}
        showSticky={false}
        listLabel="Sections"
        listHint="Drag to reorder · toggle to show or hide. Some ship switched off."
      />
    </>
  )
}

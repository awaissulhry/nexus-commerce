'use client'

import { useMemo } from 'react'
import type { PreferencesColumnSpec, PreferencesValue, SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import { PreferencesModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'

/**
 * "Arrange" (design band action, 00 §2.5): the ONE Customise dialog of the design system over a page's sections: ticked =
 * shown, the list = their order. A locked section (what the page says before anything is read) stays shown and first.
 * Saved per person on this device (`writeSectionLayout`, the DS's own store; a server copy is the DS's named gap). Widths
 * are not offered: the DS's width control speaks English only. People reports use it too.
 */
export function ArrangeDialog({ specs, layout, onApply, onClose, titleKey = 'arrange.title' }: { specs: readonly SectionSpec[]; layout: SectionLayoutValue; onApply: (order: string[]) => void; onClose: () => void; titleKey?: string }) {
  const t = useT('people-efficiency')
  const columns: PreferencesColumnSpec[] = useMemo(() => specs.map((spec) => ({ key: spec.id, label: spec.label, ...(spec.locked ? { locked: true } : {}) })), [specs])
  const value: PreferencesValue = useMemo(() => ({ visibleColumns: layout.order, stickyFirstColumn: false, stickyLastColumn: false, pageSize: 50, sortBy: '', sortDir: 'asc' }), [layout.order])
  return (
    <PreferencesModal
      open
      onClose={onClose}
      value={value}
      onConfirm={(next) => onApply(next.visibleColumns)}
      allColumns={columns}
      defaultVisible={specs.map((spec) => spec.id)}
      pageSizeChoices={[]}
      sortFieldOptions={[]}
      showSticky={false}
      title={t(titleKey)}
      listLabel={t('arrange.list')}
      listHint={t('arrange.hint')}
      confirmLabel={t('arrange.apply')}
    />
  )
}

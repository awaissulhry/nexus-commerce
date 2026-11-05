'use client'

import { useMemo, useState } from 'react'
import type { PreferencesColumnSpec, PreferencesValue, SectionLayoutValue, SectionSpec, SectionWidth } from '@nexus/ui/patterns'
import { Select } from '@nexus/ui/primitives'
import { PreferencesModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WIDTHS } from '../model'

/**
 * "Arrange panels" (design pop:qr-arrange; 00 §2.5): the ONE Customise dialog of the design system over the page's panels —
 * ticked = shown, the list = their order — and each panel's width (full, two thirds, half) in the dialog's side slot, in the
 * page's language (the DS SectionLayout's own width button speaks English only). Done applies both; Esc closes and focus goes
 * back to Arrange (the DS dialog's rule). Saved per person on this device (the DS's own store; a server copy is the DS's
 * named gap).
 */
export function ArrangeDialog({ specs, layout, onApply, onClose }: { specs: readonly SectionSpec[]; layout: SectionLayoutValue; onApply: (next: SectionLayoutValue) => void; onClose: () => void }) {
  const t = useT('quality-reports')
  const [widths, setWidths] = useState<Record<string, SectionWidth>>(() => ({ ...layout.widths }))
  const columns: PreferencesColumnSpec[] = useMemo(() => specs.map((spec) => ({ key: spec.id, label: spec.label })), [specs])
  const value: PreferencesValue = useMemo(() => ({ visibleColumns: layout.order, stickyFirstColumn: false, stickyLastColumn: false, pageSize: 50, sortBy: '', sortDir: 'asc' }), [layout.order])
  return (
    <PreferencesModal
      open
      onClose={onClose}
      value={value}
      onConfirm={(next) => onApply({ order: next.visibleColumns, widths })}
      allColumns={columns}
      defaultVisible={specs.map((spec) => spec.id)}
      pageSizeChoices={[]}
      sortFieldOptions={[]}
      showSticky={false}
      title={t('arrange.title')}
      listLabel={t('arrange.list')}
      listHint={t('arrange.hint')}
      confirmLabel={t('arrange.apply')}
      workspaceSlot={
        <fieldset className="fw-qr-widths">
          <legend className="fw-qr-widths-legend">{t('arrange.widths')}</legend>
          {specs.map((spec) => (
            <label key={spec.id} className="fw-qr-width">
              <span>{spec.label}</span>
              <Select size="sm" aria-label={t('arrange.widthOf', { panel: spec.label })} value={widths[spec.id] ?? 'full'} onChange={(event) => setWidths((current) => ({ ...current, [spec.id]: event.target.value as SectionWidth }))}>
                {WIDTHS.map((width) => (
                  <option key={width} value={width}>
                    {t(`arrange.width.${width}`)}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </fieldset>
      }
    />
  )
}

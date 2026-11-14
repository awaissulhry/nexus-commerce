'use client'

import { useMemo, useState } from 'react'
import type { PreferencesColumnSpec, PreferencesValue, SectionLayoutValue, SectionSpec, SectionWidth } from '@nexus/ui/patterns'
import { Banner } from '@nexus/ui/components'
import { Button, Select } from '@nexus/ui/primitives'
import { PreferencesModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'

const WIDTHS: readonly SectionWidth[] = ['half', 'two-thirds', 'full']

/**
 * "Arrange dashboard" (design home.dashboards pop:arrange: "Panels, order, widths; server-saved per person"; keys Space ·
 * ⌥↑/⌥↓ · Enter · Esc): the ONE Customise dialog of the design system over the dashboard's panels and the reports pinned to it —
 * ticked = shown, the list = their order, the numbers always shown — and each panel's width in the dialog's side slot, in the
 * page's language. Apply hands the arrangement to the container (PUT …/layout, saved on the server for this person on every
 * device); "Back to the dashboard's order" forgets it (DELETE …/layout). A refused save says why here.
 */
export function ArrangeDialog({
  specs,
  layout,
  saved,
  busy,
  problem,
  onApply,
  onReset,
  onClose,
}: {
  specs: readonly SectionSpec[]
  layout: SectionLayoutValue
  saved: boolean
  busy: boolean
  problem: string | null
  onApply: (next: SectionLayoutValue) => void
  onReset: () => void
  onClose: () => void
}) {
  const t = useT('home-dashboards')
  const [widths, setWidths] = useState<Record<string, SectionWidth>>(() => ({ ...layout.widths }))
  const columns: PreferencesColumnSpec[] = useMemo(() => specs.map((spec) => ({ key: spec.id, label: spec.label, ...(spec.locked ? { alwaysShown: true } : {}) })), [specs])
  const value: PreferencesValue = useMemo(() => ({ visibleColumns: layout.order, stickyFirstColumn: false, stickyLastColumn: false, pageSize: 50, sortBy: '', sortDir: 'asc' }), [layout.order])
  return (
    <PreferencesModal
      open
      onClose={onClose}
      value={value}
      onConfirm={(next) => onApply({ order: next.visibleColumns, widths })}
      allColumns={columns}
      defaultVisible={specs.filter((spec) => !spec.defaultHidden).map((spec) => spec.id)}
      pageSizeChoices={[]}
      sortFieldOptions={[]}
      showSticky={false}
      title={t('arrange.title')}
      listLabel={t('arrange.list')}
      listHint={t('arrange.hint')}
      confirmLabel={t('arrange.apply')}
      workspaceSlot={
        <div className="fw-dash-arrange">
          {problem ? (
            <Banner tone="danger" title={t('arrange.refused')}>
              {t(problem)}
            </Banner>
          ) : null}
          <fieldset className="fw-dash-widths">
            <legend className="fw-dash-widths-legend">{t('arrange.widths')}</legend>
            {specs.map((spec) => (
              <label key={spec.id} className="fw-dash-width">
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
          <p className="fw-dash-muted">{t('arrange.server')}</p>
          <Button size="sm" onClick={onReset} heldReason={!saved ? t('arrange.resetHeld') : busy ? t('arrange.saving') : undefined}>
            {t('arrange.reset')}
          </Button>
        </div>
      }
    />
  )
}

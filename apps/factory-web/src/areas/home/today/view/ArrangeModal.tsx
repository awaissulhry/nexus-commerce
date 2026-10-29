'use client'

import { useEffect, useMemo, useState } from 'react'
import { PreferencesModal, type PreferencesColumnSpec, type PreferencesValue } from '@nexus/ui/patterns'
import { Select } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { PANEL_WIDTHS, sectionOrder, TODAY_SECTIONS, type PanelWidth, type TodayLayout, type TodaySection } from '../model'

/**
 * "Arrange Today" (design home.today popup `arrange`, W1: show or hide, order, widths, "My main role"; saved on the
 * server per person). The ONE Customise dialog of the design system (PreferencesModal) holds the sections and the
 * panels of My lists: ticked = shown, the "in view" list = their order ("Needs me now" is always shown). Its left panel
 * holds what the column dialog has no place for: each panel's width (half, two thirds, the whole row) and the lens the
 * flow strip opens on. Apply hands the layout to the container (PUT /home/today/layout); Cancel keeps nothing.
 */

const SECTION = (id: TodaySection) => `section:${id}`
/** The sections' message keys (`today.arrange.section.<key>`). */
const SECTION_KEY: Readonly<Record<TodaySection, string>> = { 'focus-strip': 'focusStrip', 'needs-me': 'needsMe', flow: 'flow', 'role-panels': 'rolePanels' }
const PANEL = (id: string) => `panel:${id}`

export function ArrangeModal({
  open,
  layout,
  panels,
  lenses,
  onApply,
  onClose,
}: {
  open: boolean
  layout: TodayLayout
  /** The panels the person may see, under any lens. */
  panels: readonly { readonly id: string }[]
  lenses: readonly { readonly lens: string; readonly label: string }[]
  onApply: (layout: TodayLayout) => void | Promise<void>
  onClose: () => void
}) {
  const t = useT('home')
  const label = (key: string, fallback: string) => (t(key) === key ? fallback : t(key))
  const [widths, setWidths] = useState<Record<string, PanelWidth>>({})
  const [mainLens, setMainLens] = useState<string | null>(layout.mainLens)
  useEffect(() => {
    if (!open) return
    setWidths(Object.fromEntries(panels.map((panel) => [panel.id, layout.panels.find((entry) => entry.id === panel.id)?.width ?? 'HALF'])))
    setMainLens(layout.mainLens)
  }, [open, layout, panels])

  const sectionsGroup = t('today.arrange.groupSections')
  const panelsGroup = t('today.arrange.groupPanels')
  const columns: PreferencesColumnSpec[] = useMemo(
    () => [
      ...TODAY_SECTIONS.map((id) => ({ key: SECTION(id), label: t(`today.arrange.section.${SECTION_KEY[id]}`), group: sectionsGroup, groupKey: 'sections', ...(id === 'needs-me' ? { alwaysShown: true } : {}) })),
      ...panels.map((panel) => ({ key: PANEL(panel.id), label: t(`today.panels.${panel.id}.title`), group: panelsGroup, groupKey: 'panels' })),
    ],
    [panels, t, sectionsGroup, panelsGroup],
  )
  const defaults = useMemo(() => [...TODAY_SECTIONS.map(SECTION), ...panels.map((panel) => PANEL(panel.id))], [panels])
  const value: PreferencesValue = useMemo(() => {
    const sections = sectionOrder(layout).filter((id) => id === 'needs-me' || !(layout.sections.find((entry) => entry.id === id)?.hidden ?? false))
    const named = new Set(layout.panels.map((entry) => entry.id))
    const shownPanels = [...layout.panels.filter((entry) => !entry.hidden && panels.some((panel) => panel.id === entry.id)).map((entry) => entry.id), ...panels.filter((panel) => !named.has(panel.id)).map((panel) => panel.id)]
    return { visibleColumns: [...sections.map(SECTION), ...shownPanels.map(PANEL)], stickyFirstColumn: false, stickyLastColumn: false, pageSize: 50, sortBy: '', sortDir: 'asc' }
  }, [layout, panels])

  const apply = (next: PreferencesValue) => {
    const visible = next.visibleColumns
    const shownSections = visible.filter((key) => key.startsWith('section:')).map((key) => key.slice('section:'.length) as TodaySection)
    const sections = [...shownSections.map((id) => ({ id, hidden: false })), ...TODAY_SECTIONS.filter((id) => !shownSections.includes(id)).map((id) => ({ id, hidden: id !== 'needs-me' }))]
    const shownPanels = visible.filter((key) => key.startsWith('panel:')).map((key) => key.slice('panel:'.length))
    const arranged = [
      ...shownPanels.map((id) => ({ id, hidden: false, width: widths[id] ?? 'HALF' })),
      ...panels.filter((panel) => !shownPanels.includes(panel.id)).map((panel) => ({ id: panel.id, hidden: true, width: widths[panel.id] ?? 'HALF' })),
    ]
    return onApply({ sections, panels: arranged, mainLens })
  }

  const slot = (
    <div className="fw-today-arrange">
      {lenses.length > 1 && (
        <label className="fw-today-field">
          <span className="fw-today-field-label">{t('today.arrange.mainLens')}</span>
          <Select value={mainLens ?? ''} onChange={(event) => setMainLens(event.target.value === '' ? null : event.target.value)}>
            <option value="">{t('today.arrange.mainLensNone')}</option>
            {lenses.map((entry) => (
              <option key={entry.lens} value={entry.lens}>
                {label(`today.flow.lens.${entry.lens}`, entry.label)}
              </option>
            ))}
          </Select>
          <span className="fw-today-muted">{t('today.arrange.mainLensHint')}</span>
        </label>
      )}
      {panels.length > 0 && (
        <fieldset className="fw-today-arrange-widths">
          <legend className="fw-today-field-label">{t('today.arrange.widths')}</legend>
          <span className="fw-today-muted">{t('today.arrange.widthsHint')}</span>
          {panels.map((panel) => (
            <label key={panel.id} className="fw-today-arrange-width">
              <span>{t(`today.panels.${panel.id}.title`)}</span>
              <Select size="sm" aria-label={t('today.arrange.widthOf', { panel: t(`today.panels.${panel.id}.title`) })} value={widths[panel.id] ?? 'HALF'} onChange={(event) => setWidths((current) => ({ ...current, [panel.id]: event.target.value as PanelWidth }))}>
                {PANEL_WIDTHS.map((width) => (
                  <option key={width} value={width}>
                    {t(`today.arrange.width.${width}`)}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  )

  return (
    <PreferencesModal
      open={open}
      onClose={onClose}
      value={value}
      onConfirm={apply}
      allColumns={columns}
      defaultVisible={defaults}
      pageSizeChoices={[]}
      sortFieldOptions={[]}
      showSticky={false}
      title={t('today.arrange.title')}
      listLabel={t('today.arrange.list')}
      listHint={t('today.arrange.listHint')}
      workspaceSlot={slot}
      confirmLabel={t('today.arrange.apply')}
    />
  )
}

'use client'

import { useEffect } from 'react'
import { ChevronDown, Upload } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { SegmentedControl } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { LIBRARIES, libraryOfKey, type Library } from '../model'
import { isTypingKey } from './parts'

export interface LibrarySwitchModel {
  library: Library
  /** Why Import is held (a key of this catalogue), or null. */
  importHeld: string | null
}

export interface LibrarySwitchActions {
  onLibrary?: (library: Library) => void
  onImport?: (importer: 'poms' | 'rules') => void
}

/**
 * The Sizes page's view switch (B-W2b-240; design products.sizes sec:sizes.view "SegmentedControl: Size scales ·
 * Measurement templates · Points of measure (W2b) · Grade rules (W2b)", keys 1–4; the address keeps it, `?view=`) and
 * its Import (W2b) — a sheet of points of measure or of grade rules, through the import wizard. B-W2b-362: the
 * measurement templates (B-W1-17) are the second segment now (B-W2b-283's list). It fetches nothing.
 */
export function LibrarySwitch({ model, actions }: { model: LibrarySwitchModel; actions?: LibrarySwitchActions }) {
  return (
    <WithMessages namespaces={['products-sizes-depth']}>
      <Switch model={model} actions={actions} />
    </WithMessages>
  )
}

function Switch({ model, actions }: { model: LibrarySwitchModel; actions?: LibrarySwitchActions }) {
  const t = useT('products-sizes-depth')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingKey(event)) return
      const next = libraryOfKey(event.key)
      if (!next || next === model.library) return
      event.preventDefault()
      actions?.onLibrary?.(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const held = model.importHeld ? t(model.importHeld) : undefined
  return (
    <div className="fw-szd-switch">
      <SegmentedControl
        ariaLabel={t('switch.label')}
        size="sm"
        wrap
        value={model.library}
        onChange={(value) => actions?.onLibrary?.(value as Library)}
        options={LIBRARIES.map((library, index) => ({ value: library, label: t(`switch.${library}`), title: t('switch.key', { key: index + 1 }) }))}
      />
      <Menu
        label={
          <span className="fw-szd-inline">
            <Upload size={14} aria-hidden /> {t('import.menu')} <ChevronDown size={14} aria-hidden />
          </span>
        }
        align="right"
        triggerProps={{ 'aria-label': t('import.menu') }}
        items={[
          { id: 'poms', label: t('import.poms'), disabled: !!held, description: held, onSelect: () => actions?.onImport?.('poms') },
          { id: 'rules', label: t('import.rules'), disabled: !!held, description: held, onSelect: () => actions?.onImport?.('rules') },
        ]}
      />
    </div>
  )
}

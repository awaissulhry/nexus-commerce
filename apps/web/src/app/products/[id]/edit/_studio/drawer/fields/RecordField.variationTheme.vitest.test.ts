import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../contracts', () => ({
  usePublicationSave: () => ({ registerPublicationBarrier: () => () => {} }),
  useStudioScope: () => ({ registerScopeChangeGuard: () => () => {} }),
}))

import { GALE_MASTER } from '../../../../../../../../../../docs/fixtures/vt1/fixtures'
import { RecordField } from './RecordField'
import type { SheetColumn, StudioCellValue } from '../types'

const variationThemeColumn: SheetColumn = {
  key: 'variation_theme',
  writeField: 'variation_theme',
  label: 'Variation theme',
  group: 'Identity',
  kind: 'variationTheme',
  shape: 'axes',
  storage: 'categoryAttributes',
  scope: 'global',
  requiredBy: [],
  editable: true,
}

const cell: StudioCellValue = {
  value: GALE_MASTER,
  source: 'master',
  inheritedFrom: null,
  inherited: false,
  layer: 'master',
  editable: true,
  writable: true,
}

describe('variation theme in the record drawer', () => {
  it('renders the canonical axes summary as a read-only field instead of stringifying its object', () => {
    const html = renderToStaticMarkup(createElement(RecordField, {
      column: variationThemeColumn,
      cell,
      onWrite: vi.fn(),
      onReset: vi.fn(),
      onHistory: vi.fn(),
    }))

    expect(html).toContain('Color · Size')
    expect(html).toContain('Edit the variation theme in the sheet.')
    expect(html).not.toContain('[object Object]')
    expect(html).toContain('readonly=""')
    expect(html).not.toContain('Write a formula')
    expect(html).not.toContain('Reset to the inherited value')
  })
})

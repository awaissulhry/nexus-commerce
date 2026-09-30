import { expect, it } from 'vitest'
import { pickFor } from '../../../smoke/sheet/drivers'

it('still exercises paste when the four-option fixture has two unused choices', () => {
  const pick = pickFor('ListPanelEditor', {
    key: 'occasion', label: 'Occasion', kind: 'select', shape: 'list', editable: true,
    options: ['Birthday', 'Wedding', 'Travel', 'Sport'],
  }, ['Birthday', 'Travel'], 2, 'paste', { themes: [] })
  expect(pick.skip).toBeUndefined()
  expect(pick.wire).toEqual(['Wedding'])
})

it('keeps numeric option codes typed on keyboard and paste paths', () => {
  const column = { key: 'codes', label: 'Codes', kind: 'number', shape: 'list', editable: true, options: ['7', '8', '9'] }
  const keyboard = pickFor('ListPanelEditor', column, [7], 0, 'keyboard', { themes: [] })
  expect(keyboard.skip).toBeUndefined()
  expect(keyboard.wire).toEqual([7, 8])
  const paste = pickFor('ListPanelEditor', column, [7, 8], 2, 'paste', { themes: [] })
  expect(paste.skip).toBeUndefined()
  expect(paste.wire).toEqual([9])
})

import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CellClassParams, ColDef, ValueFormatterParams, ValueGetterParams, ValueParserParams, ValueSetterParams } from 'ag-grid-community'
import { sizeColumnGroup, sizeColumns, sizeColumnSize, SIZE_COLUMN_CLASSES } from './sizeColumns'
import { SizeFill } from './SizeFill'
import { SIZE_COLUMNS_LABELS } from './SizeColumnsLabels'
import {
  addSizeValues,
  fillFromBase,
  parseSizeValue,
  pasteSizeRow,
  sizeEditText,
  sizeTotals,
  sizeValueOf,
  sizeValueText,
  subtractSizeValues,
  timesSizeValue,
} from './sizeColumnsModel'

/** B-W2b-207 — SizeColumns. Made-up rows. */
interface Row {
  id: string
  needs: boolean
  by: Record<string, string | null>
  typed?: string[]
}
const SIZES = ['XS', 'S', 'M', 'L', 'XL']
const ROW: Row = { id: 'chest', needs: true, by: { XS: '54', S: '56.5', M: '59.0000', L: null, XL: '64' }, typed: ['XL'] }
const LOOSE: Row = { id: 'label', needs: false, by: {} }

describe('typing a decimal per size', () => {
  it('a comma or a point, no grouping, spaces ignored; empty, a dash or the missing words clear', () => {
    expect(parseSizeValue('62,5')).toEqual({ ok: true, value: '62.5' })
    expect(parseSizeValue(' 62.50 ')).toEqual({ ok: true, value: '62.5' })
    expect(parseSizeValue('1 250')).toEqual({ ok: true, value: '1250' })
    expect(parseSizeValue('1.250')).toEqual({ ok: true, value: '1.25' })
    expect(parseSizeValue(',5')).toEqual({ ok: true, value: '0.5' })
    expect(parseSizeValue('007')).toEqual({ ok: true, value: '7' })
    for (const empty of ['', '  ', '—', '-', null, undefined]) expect(parseSizeValue(empty)).toEqual({ ok: true, value: null })
    expect(parseSizeValue('— missing', { missingWords: ['— missing'] })).toEqual({ ok: true, value: null })
  })

  it('refuses what is not a number, grouping, a minus unless allowed, and more decimals than the scale', () => {
    for (const bad of ['abc', '1.234,5', '1,2,3', '6e2', '12cm', '--1']) expect(parseSizeValue(bad), bad).toEqual({ ok: false })
    expect(parseSizeValue('-1.5')).toEqual({ ok: false })
    expect(parseSizeValue('-1,5', { negative: true })).toEqual({ ok: true, value: '-1.5' })
    expect(parseSizeValue('-0', { negative: true })).toEqual({ ok: true, value: '0' })
    expect(parseSizeValue('1.23456')).toEqual({ ok: false })
    expect(parseSizeValue('1.23456', { scale: 5 })).toEqual({ ok: true, value: '1.23456' })
    expect(parseSizeValue(Number.NaN)).toEqual({ ok: false })
  })

  it('written in the page’s language; typed back with its separator; null stays missing', () => {
    expect(sizeValueText('1250.5', 'it-IT')).toBe('1250,5')
    expect(sizeValueText('62.5', 'en-GB')).toBe('62.5')
    expect(sizeValueText(null)).toBeNull()
    expect(sizeEditText('6.3500', 'it-IT')).toBe('6,35')
    expect(sizeEditText('6.3500', 'en-GB')).toBe('6.35')
    expect(sizeEditText(null, 'it-IT')).toBe('')
    expect(sizeValueOf('0.0')).toBe('0')
  })
})

describe('exact arithmetic (no floats)', () => {
  it('adds, multiplies and subtracts on scaled integers', () => {
    expect(addSizeValues('1.1', timesSizeValue('0.1', 3))).toBe('1.4')
    expect(addSizeValues('0.1', '0.2')).toBe('0.3')
    expect(subtractSizeValues('59', '56.5')).toBe('2.5')
    expect(subtractSizeValues('56.5', '59')).toBe('-2.5')
    expect(timesSizeValue('-2.5', -2)).toBe('5')
  })
})

describe('fill from the base by an increment', () => {
  const values = { XS: null, S: '56', M: '59', L: '61', XL: '70' }
  it('each size = the base + its steps × the increment; the base stays; only the cells that change are listed', () => {
    const result = fillFromBase({ sizes: SIZES, base: 'M', values, increment: '2.5' })
    expect(result.ok && result.values).toEqual({ XS: '54', S: '56.5', M: '59', L: '61.5', XL: '64' })
    expect(result.ok && result.changes).toEqual([
      { size: 'XS', from: null, to: '54' },
      { size: 'S', from: '56', to: '56.5' },
      { size: 'L', from: '61', to: '61.5' },
      { size: 'XL', from: '70', to: '64' },
    ])
  })
  it('keeps values typed by hand; refuses without a base, a base value, or below zero', () => {
    const kept = fillFromBase({ sizes: SIZES, base: 'M', values, increment: '2.5', keep: ['XL'] })
    expect(kept.ok && kept.values.XL).toBe('70')
    expect(fillFromBase({ sizes: SIZES, base: null, values, increment: '1' })).toEqual({ ok: false, problem: 'noBase' })
    expect(fillFromBase({ sizes: SIZES, base: 'XS', values, increment: '1' })).toEqual({ ok: false, problem: 'baseMissing', size: 'XS' })
    expect(fillFromBase({ sizes: SIZES, base: 'M', values, increment: '30' })).toEqual({ ok: false, problem: 'belowZero', size: 'XS' })
  })
})

describe('totals and paste', () => {
  it('a size with a missing row has no total; never a smaller number', () => {
    expect(sizeTotals([ROW, { ...ROW, by: { ...ROW.by, L: '1' } }], SIZES, (row, size) => row.by[size])).toEqual([
      { size: 'XS', total: '108' },
      { size: 'S', total: '113' },
      { size: 'M', total: '118' },
      { size: 'L', total: null },
      { size: 'XL', total: '128' },
    ])
    expect(sizeTotals([], SIZES, () => '1')[0]).toEqual({ size: 'XS', total: null })
  })
  it('a row pasted from a spreadsheet lands from the picked size on; words are refused; past the end is counted', () => {
    expect(pasteSizeRow('56,5\t59\tx\t64\t66\t68\n', SIZES, 'S')).toEqual({
      values: [
        { size: 'S', value: '56.5' },
        { size: 'M', value: '59' },
        { size: 'XL', value: '64' },
      ],
      refused: [{ size: 'L', text: 'x' }],
      over: 2,
    })
    expect(pasteSizeRow('1 2', SIZES, 'XL')).toEqual({ values: [{ size: 'XL', value: '1' }], refused: [], over: 1 })
    expect(pasteSizeRow('1;2', SIZES, 'nope').over).toBe(2)
  })
})

describe('sizeColumns', () => {
  const onChange = vi.fn()
  const onRefused = vi.fn()
  const columns = sizeColumns<Row>({
    sizes: SIZES,
    base: 'M',
    unit: 'cm',
    value: (row, size) => row.by[size],
    editable: (row) => row.needs,
    required: (row) => row.needs,
    isOverride: (row, size) => !!row.typed?.includes(size),
    onChange,
    onRefused,
    locale: 'it-IT',
  })
  const col = (size: string) => columns.find((c) => c.colId === `size:${size}`) as ColDef<Row> & Record<string, unknown>
  const get = (size: string, data: Row) => (col(size).valueGetter as (p: ValueGetterParams<Row>) => unknown)({ data } as ValueGetterParams<Row>)
  const fmt = (size: string, data: Row) => (col(size).valueFormatter as (p: ValueFormatterParams<Row>) => string)({ data, value: get(size, data) } as ValueFormatterParams<Row>)
  const rule = (size: string, cls: string, data: Row) => ((col(size).cellClassRules as Record<string, (p: CellClassParams<Row>) => boolean>)[cls]!)({ data } as CellClassParams<Row>)

  it('one column per size, the base marked in its header words and class', () => {
    expect(columns.map((c) => c.headerName)).toEqual(['XS', 'S', 'M · base', 'L', 'XL'])
    expect(col('M').headerClass).toContain(SIZE_COLUMN_CLASSES.headBase)
    expect(col('M').cellClass).toContain(SIZE_COLUMN_CLASSES.base)
    expect(col('S').cellClass).not.toContain(SIZE_COLUMN_CLASSES.base)
    expect(col('M').headerTooltip).toBe('Size M · cm · base size')
    expect([col('S').flex, col('S').minWidth, col('M').minWidth, col('S').suppressHeaderMenuButton]).toEqual([1, 80, 104, true])
    expect(sizeColumns<Row>({ sizes: ['S'], value: () => null, width: 70 })[0]).toMatchObject({ width: 70 })
  })

  it('a value in the page’s language; a missing one in words and the error tone, never 0; not needed is a plain dash', () => {
    expect(fmt('S', ROW)).toBe('56,5')
    expect(get('M', ROW)).toBe('59')
    expect(fmt('L', ROW)).toBe(SIZE_COLUMNS_LABELS.missing)
    expect(rule('L', SIZE_COLUMN_CLASSES.missing, ROW)).toBe(true)
    expect(rule('S', SIZE_COLUMN_CLASSES.missing, ROW)).toBe(false)
    expect(fmt('L', LOOSE)).toBe('—')
    expect(rule('L', SIZE_COLUMN_CLASSES.notNeeded, LOOSE)).toBe(true)
    expect(rule('XL', SIZE_COLUMN_CLASSES.override, ROW)).toBe(true)
    const tip = col('XL').tooltipValueGetter!({ data: ROW } as never)
    expect(tip).toBe('XL: 64 cm · typed by hand')
  })

  it('typing: parsed in either separator; a word is refused and the value kept; one onChange per changed cell', () => {
    const parse = (size: string, text: string) => (col(size).valueParser as (p: ValueParserParams<Row>) => unknown)({ data: ROW, newValue: text, oldValue: get(size, ROW) } as ValueParserParams<Row>)
    const set = (size: string, value: unknown) => (col(size).valueSetter as (p: ValueSetterParams<Row>) => boolean)({ data: ROW, newValue: value } as ValueSetterParams<Row>)
    expect(parse('S', '57,25')).toBe('57.25')
    expect(parse('S', 'abc')).toBe('56.5')
    // AG leaves `oldValue` out on some edit paths: the refused text still keeps the row's value.
    expect((col('S').valueParser as (p: ValueParserParams<Row>) => unknown)({ data: ROW, newValue: 'abc' } as ValueParserParams<Row>)).toBe('56.5')
    expect(onRefused).toHaveBeenCalledWith(ROW, 'S', 'abc')
    expect(parse('S', '— missing')).toBeNull()
    onRefused.mockClear()
    // The editor's text reaches the setter as typed (AG36): parsed there by the same rule; a word changes nothing.
    expect(set('S', 'xyz')).toBe(false)
    expect(onRefused).toHaveBeenCalledWith(ROW, 'S', 'xyz')
    expect(onChange).not.toHaveBeenCalled()
    expect(set('S', '57,25')).toBe(false)
    expect(onChange).toHaveBeenCalledWith(ROW, 'S', '57.25')
    onChange.mockClear()
    expect(set('S', '57.25')).toBe(false)
    expect(onChange).toHaveBeenCalledWith(ROW, 'S', '57.25')
    onChange.mockClear()
    expect(set('S', '56.50')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    const editable = col('S').editable as (p: { data?: Row }) => boolean
    expect([editable({ data: ROW }), editable({ data: LOOSE })]).toEqual([true, false])
  })

  it('a group under one header', () => {
    const group = sizeColumnGroup<Row>({ sizes: SIZES, unit: 'cm', value: (row, size) => row.by[size] })
    expect(group.headerName).toBe('Per size (cm)')
    expect(group.children).toHaveLength(5)
    expect([sizeColumnSize('size:M'), sizeColumnSize('pom'), sizeColumnSize(null), sizeColumnSize('qty-XL', 'qty-')]).toEqual(['M', null, null, 'XL'])
  })
})

describe('SizeFill', () => {
  const values = { XS: null, S: '56', M: '59', L: '61', XL: '70' }
  it('the base, the increment, the preview of every change, Fill ready', () => {
    const html = render(h(SizeFill, { sizes: SIZES, base: 'M', values, unit: 'cm', defaultIncrement: '2,5', overrides: ['XL'], onApply: () => undefined }))
    expect(html).toContain('Base M: 59 cm')
    expect(html).toContain('Keep the value typed by hand')
    expect(html).toContain('3 values change')
    expect(html).toContain('<span class="nds-sizefill-sr">XS: missing → 54 cm</span>')
    expect(html).not.toContain('aria-disabled')
  })
  it('held with the reason: no increment, not a number, no base value, below zero, nothing to change, the page’s reason', () => {
    const held = (props: Record<string, unknown>) => render(h(SizeFill, { sizes: SIZES, base: 'M', values, onApply: () => undefined, ...props }))
    expect(held({})).toContain('Type the increment first.')
    expect(held({ defaultIncrement: 'x' })).toContain('The increment is not a number.')
    expect(held({ base: 'XS', defaultIncrement: '1' })).toContain('Enter the value of the base size XS first.')
    expect(held({ defaultIncrement: '30' })).toContain('Size XS would be 0 or less')
    expect(held({ values: { XS: '56', S: '57.5', M: '59', L: '60.5', XL: '62' }, defaultIncrement: '1.5' })).toContain('Nothing would change.')
    expect(held({ defaultIncrement: '1', heldReason: 'Rev 3 is released and frozen.' })).toContain('Rev 3 is released and frozen.')
    expect(held({ base: null, defaultIncrement: '1' })).toContain('Set a base size first.')
  })
})

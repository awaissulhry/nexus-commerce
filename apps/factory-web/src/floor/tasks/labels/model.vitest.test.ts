import { describe, expect, it } from 'vitest'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { readScan } from '../../scan/scan-model'
import type { LabelPrinter, PrintedLine, RenderedLabel, ViewCell } from './api'
import { colourGroups, firstCell, gateOf, jobsOf, labelsScan, mainAction, previewLayout, printAll, printerChoice, printerIdOf, problemsOf, type Context } from './model'

/**
 * The garment labels' rules (SCR-096; design floor.labels): what a scan opens, the pad, the certificate gate in words,
 * which print is offered and why one is held, the printer, the jobs, and the label as the DS draws it.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const covered = { outcome: 'covered' as const, certificate: { id: 'c1', number: 'CERT-1', standard: 'EN 17092-4', ppeClass: 'A', validTo: '2028-03-31' }, words: '' }
const cell = (id: string, size: string, finished: number | null, labelled: number, extra: Partial<ViewCell> = {}): ViewCell => ({
  workOrderSizeId: id,
  colourwayId: 'cw',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  size,
  quantity: 10,
  finished,
  labelled,
  reprinted: 0,
  toLabel: Math.max(0, (finished ?? 0) - labelled),
  overLabelled: 0,
  gate: covered,
  printable: true,
  refusal: null,
  ...extra,
})
const printer = (id: string, holdsLabel = true): LabelPrinter => ({ id, code: id.toUpperCase(), name: id, labelWidthMm: 50, labelHeightMm: 80, holdsLabel })
const context = (extra: Partial<Context> = {}): Context => ({ online: true, busy: false, blocked: false, printer: printerChoice([printer('p1')], null), tracking: 'BATCH', serial: null, ...extra })

describe('what a scan on the labels screen asks', () => {
  it('a bundle, a serial, a work order label or a typed number asks the office; a badge switches person', () => {
    expect(labelsScan(readScan(formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 12 }), TAG)).kind).toBe('lookup')
    expect(labelsScan(readScan(formatScanId({ type: 'SERIAL', tenantTag: TAG, ref: 77 }), TAG)).kind).toBe('lookup')
    expect(labelsScan(readScan('WO-0042', TAG))).toEqual({ kind: 'lookup', code: 'WO-0042' })
    expect(labelsScan(readScan(formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4 }), TAG))).toMatchObject({ kind: 'notHere', why: 'otherLabel' })
  })
})

describe('the pad and the gate', () => {
  const cells = [cell('a', '50', 4, 4), cell('b', '52', 6, 2), cell('c', '54', null, 0), cell('d', '60', 2, 0, { printable: false, gate: { outcome: 'refused', certificate: null, words: 'expired' } })]

  it('groups sizes by colour and opens on the scanned size, else the first with labels to print', () => {
    expect(colourGroups(cells)).toHaveLength(1)
    expect(colourGroups(cells)[0]!.sizes.map((size) => [size.size, size.toLabel, size.printable])).toEqual([
      ['50', 0, true],
      ['52', 4, true],
      ['54', 0, true],
      ['60', 2, false],
    ])
    expect(firstCell(cells, 'c')).toBe('c')
    expect(firstCell(cells, 'zz')).toBe('b')
    expect(firstCell(cells.slice(0, 1), null)).toBe('a')
  })

  it('says the gate in words: covered with its certificate, refused with its code, not required', () => {
    expect(gateOf(cells[1]!)).toEqual({ kind: 'covered', standard: 'EN 17092-4', ppeClass: 'A', number: 'CERT-1', validTo: '2028-03-31' })
    expect(gateOf(cells[3]!)).toMatchObject({ kind: 'refused', code: 'CERTIFICATE' })
    expect(gateOf(cell('e', '56', 1, 0, { refusal: { code: 'TEMPLATE_NOT_ACTIVE', message: 'm', fix: 'f', workOrderSizeId: 'e' } }))).toMatchObject({ kind: 'refused', code: 'TEMPLATE_NOT_ACTIVE' })
    expect(gateOf(cell('f', '58', 1, 0, { gate: { outcome: 'not_required', certificate: null, words: '' } }))).toEqual({ kind: 'notRequired' })
  })
})

describe('the print the screen offers', () => {
  const groups = colourGroups([cell('a', '50', 4, 4), cell('b', '52', 6, 2), cell('d', '60', 2, 0, { printable: false })])
  const [s50, s52, s60] = groups[0]!.sizes

  it('prints a size with labels to print; a refused size is held with the gate as the reason, never printed', () => {
    expect(mainAction(s52!, context())).toEqual({ kind: 'print', count: 4, held: null })
    expect(mainAction(s60!, context())).toEqual({ kind: 'print', count: 2, held: 'refused' })
  })

  it('a labelled size asks why before printing again (batch); a serial style needs the serial scanned', () => {
    expect(mainAction(s50!, context())).toEqual({ kind: 'reprint', printed: 4, held: null })
    expect(mainAction(s50!, context({ tracking: 'SERIAL' }))).toEqual({ kind: 'none', held: 'scanSerial' })
    expect(mainAction(s50!, context({ tracking: 'SERIAL', serial: { id: 'sn1', serial: 'SN-1', workOrderSizeId: 'a' } }))).toEqual({ kind: 'reprintSerial', serial: 'SN-1', held: null })
  })

  it('holds every print offline, without a printer that takes the label, or until one is picked', () => {
    expect(mainAction(s52!, context({ online: false })).held).toBe('offline')
    expect(mainAction(s52!, context({ printer: printerChoice([printer('p1', false)], null) })).held).toBe('noPrinter')
    expect(mainAction(s52!, context({ printer: printerChoice([printer('p1'), printer('p2')], null) })).held).toBe('pickPrinter')
    expect(mainAction(s52!, context({ printer: printerChoice([printer('p1'), printer('p2')], 'p2') })).held).toBeNull()
    expect(mainAction(s52!, context({ blocked: true })).held).toBe('blocked')
  })

  it('Print all counts only the printable sizes; nothing left is held', () => {
    expect(printAll(groups, context())).toEqual({ count: 4, sizes: 1, held: null })
    expect(printAll(colourGroups([cell('a', '50', 4, 4)]), context())).toEqual({ count: 0, sizes: 0, held: 'nothingLeft' })
  })

  it('names the printer: the only one that takes the label (API default), the picked one, never one that does not', () => {
    expect(printerIdOf(printerChoice([printer('p1'), printer('p9', false)], null))).toBe('p1')
    expect(printerIdOf(printerChoice([printer('p1'), printer('p2')], 'p9'))).toBeNull()
    expect(printerChoice([printer('p9', false)], null)).toEqual({ kind: 'none', others: 1 })
  })
})

describe('the print jobs and the label', () => {
  const job = (id: string, status: 'QUEUED' | 'FAILED') => ({ id, status, lastError: status === 'FAILED' ? 'offline' : null, copies: 4, version: 1 })
  const line = (extra: Partial<PrintedLine>): PrintedLine => ({ entryId: 'e1', workOrderSizeId: 'b', colourwayCode: 'NERO', size: '52', count: 4, batchNumber: 'BT-1', serials: [], job: null, problem: null, ...extra })

  it('one job per size of batch labels, one per serial, and the labels that made no job', () => {
    expect(jobsOf([line({ job: job('j1', 'QUEUED') })])).toEqual([{ id: 'j1', what: 'NERO 52', serial: null, copies: 4, status: 'QUEUED', detail: null, version: 1, reprint: false }])
    expect(jobsOf([line({ serials: [{ id: 's1', serial: 'SN-1', job: job('j2', 'FAILED'), problem: null }, { id: 's2', serial: 'SN-2', job: null, problem: 'Refused.' }] })], true).map((entry) => [entry.serial, entry.status, entry.reprint])).toEqual([['SN-1', 'FAILED', true]])
    expect(problemsOf([line({ serials: [{ id: 's2', serial: 'SN-2', job: null, problem: 'Refused.' }] }), line({ problem: 'No printer.' })])).toEqual([
      { what: 'NERO 52 · SN-2', problem: 'Refused.' },
      { what: 'NERO 52', problem: 'No printer.' },
    ])
  })

  it('draws the rendered label to scale: marks in one row, the heading, texts, care marks, the batch as a barcode', () => {
    const label: RenderedLabel = {
      template: { id: 't', code: 'T', revision: 1, status: 'ACTIVE', name: 'Label' },
      sample: false,
      banner: [],
      preset: 'STANDARD',
      languages: ['it'],
      blocks: [
        { field: 'ceMark', value: null, lines: [], graphic: { kind: 'CE', notifiedBodyNumber: null }, placeholder: false },
        { field: 'pictogram', value: null, lines: [], graphic: { kind: 'PICTOGRAM', pictogram: 'MOTORCYCLIST', standardCode: 'EN 17092-4', ppeClass: 'A' }, placeholder: false },
        { field: 'model', value: 'GIA-01', lines: [{ text: 'GIA-01 Giacca', language: null }], graphic: null, placeholder: false },
        { field: 'size', value: '52', lines: [{ text: 'Taglia 52', language: null }], graphic: null, placeholder: false },
        { field: 'care', value: null, lines: [], graphic: { kind: 'CARE', symbols: [{ code: 'W0', mark: 'W0', words: 'Do not wash' }] }, placeholder: false },
        { field: 'batchOrSerial', value: 'BT-1', lines: [], graphic: { kind: 'BARCODE', value: 'BT-1' }, placeholder: false },
      ],
      fit: null,
      printable: true,
    }
    const layout = previewLayout(label, { widthMm: '50', heightMm: '80' }, 'Label')
    expect([layout.widthMm, layout.heightMm]).toEqual([50, 80])
    expect(layout.blocks.map((block) => block.kind)).toEqual(['row', 'title', 'text', 'row', 'barcode'])
  })
})

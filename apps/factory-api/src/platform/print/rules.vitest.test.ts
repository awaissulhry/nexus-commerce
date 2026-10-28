import { describe, expect, it } from 'vitest'
import { canTransition } from '@nexus/factory-domain/state/machine'
import { RelayError } from '../../adapters/print-relay/port'
import { isFinalRelayError, payloadFor, printerMachine, printerProblems, printJobMachine, relayMessage } from './rules'

describe('print rules', () => {
  it('moves a job QUEUED → SENT → PRINTED, fails it from QUEUED or SENT, and queues a FAILED one again', () => {
    const ok = (from: string, to: string) => canTransition(printJobMachine, from, to).ok
    expect([ok('QUEUED', 'SENT'), ok('SENT', 'PRINTED'), ok('QUEUED', 'FAILED'), ok('SENT', 'FAILED'), ok('FAILED', 'QUEUED')]).toEqual([true, true, true, true, true])
    expect([ok('QUEUED', 'PRINTED'), ok('PRINTED', 'QUEUED'), ok('SENT', 'QUEUED'), ok('FAILED', 'SENT')]).toEqual([false, false, false, false])
    expect(printJobMachine.finals).toEqual(['PRINTED'])
    expect(canTransition(printerMachine, 'ARCHIVED', 'ACTIVE').ok).toBe(false)
    expect(canTransition(printerMachine, 'PAUSED', 'ACTIVE').ok).toBe(true)
  })

  it('wants a label printer\'s resolution and stock, and none on an A4 printer', () => {
    const label = { kind: 'LABEL_ZPL' as const, relayTarget: '10.0.0.21:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 50 }
    expect(printerProblems(label)).toEqual([])
    expect(printerProblems({ ...label, dpi: null, labelHeightMm: 30 }).map((problem) => problem.path)).toEqual(['body/dpi', 'body/labelHeightMm'])
    expect(printerProblems({ kind: 'A4_PDF', relayTarget: 'office', dpi: 300, labelWidthMm: null, labelHeightMm: null }).map((problem) => problem.path)).toEqual(['body/dpi'])
    expect(printerProblems({ kind: 'A4_PDF', relayTarget: ' ', dpi: null, labelWidthMm: null, labelHeightMm: null }).map((problem) => problem.path)).toEqual(['body/relayTarget'])
    expect([payloadFor('LABEL_ZPL'), payloadFor('A4_PDF')]).toEqual(['ZPL', 'PDF'])
  })

  it('keeps a relay\'s own words, short, and nothing of another error', () => {
    expect(relayMessage(new RelayError('Printer out of labels.'))).toBe('Printer out of labels.')
    expect(relayMessage(new RelayError('x'.repeat(400)))).toHaveLength(300)
    expect(relayMessage(new Error('connect ECONNREFUSED 10.0.0.21:9100'))).toBe('The print relay could not be reached.')
    expect([isFinalRelayError(new RelayError('no', false)), isFinalRelayError(new RelayError('later')), isFinalRelayError(new Error('x'))]).toEqual([true, false, false])
  })
})

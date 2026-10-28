import type { Issue } from '@nexus/factory-domain/core/errors'
import { stockProblems } from '@nexus/factory-domain/labels/zpl'
import { defineMachine } from '@nexus/factory-domain/state/machine'
import { RelayError } from '../../adapters/print-relay/port'

/**
 * The rules of printing (plan A1 §3.9; GAP-007), pure: what a printer must say about itself, which payload it takes,
 * how a print job moves and how often it is tried. The service (printers.ts, jobs.ts) applies them before any write;
 * the database's guard trigger (…_print_guards) holds the same invariants for every login.
 */

export const PRINTER_KINDS = ['LABEL_ZPL', 'A4_PDF'] as const
export type PrinterKind = (typeof PRINTER_KINDS)[number]
export const PRINTER_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export type PrinterStatus = (typeof PRINTER_STATUSES)[number]
export const PRINT_JOB_STATUSES = ['QUEUED', 'SENT', 'PRINTED', 'FAILED'] as const
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number]
export const PAYLOAD_KINDS = ['ZPL', 'PDF'] as const
export type PayloadKind = (typeof PAYLOAD_KINDS)[number]

/** Hand-overs to the relay before a job is FAILED (the handler's tries, with exponential backoff between them). */
export const MAX_PRINT_ATTEMPTS = 5
/** A printer's code: 1 to 24 capital letters, digits or hyphens. */
export const PRINTER_CODE = /^[A-Z0-9][A-Z0-9-]{0,23}$/
/** The longest relay message kept on a job. */
const ERROR_MAX = 300

/** What each printer takes: ZPL for a label printer, a PDF for an A4 printer. */
export const payloadFor = (kind: PrinterKind): PayloadKind => (kind === 'LABEL_ZPL' ? 'ZPL' : 'PDF')

/** A print job's moves (A1 §2.5): one writer each (queue, dispatch, relay report, send again). */
export const printJobMachine = defineMachine<PrintJobStatus>({
  name: 'print job',
  states: PRINT_JOB_STATUSES,
  transitions: { QUEUED: ['SENT', 'FAILED'], SENT: ['PRINTED', 'FAILED'], FAILED: ['QUEUED'] },
})

/** A printer's states: paused and active again; archived for good. */
export const printerMachine = defineMachine<PrinterStatus>({
  name: 'printer',
  states: PRINTER_STATUSES,
  transitions: { ACTIVE: ['PAUSED', 'ARCHIVED'], PAUSED: ['ACTIVE', 'ARCHIVED'] },
})

export interface PrinterShape {
  readonly kind: PrinterKind
  readonly relayTarget: string
  readonly dpi: number | null
  readonly labelWidthMm: number | null
  readonly labelHeightMm: number | null
}

/** What is wrong with a printer's description (empty when nothing is). */
export function printerProblems(printer: PrinterShape, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (printer.relayTarget.trim() === '' || printer.relayTarget.length > 200) problems.push({ path: `${at}/relayTarget`, message: 'Say where the relay reaches the printer (an address or a queue name).' })
  if (printer.kind === 'LABEL_ZPL') {
    problems.push(...stockProblems({ dpi: printer.dpi ?? 0, widthMm: printer.labelWidthMm ?? 0, heightMm: printer.labelHeightMm ?? 0 }, at))
  } else if (printer.dpi !== null || printer.labelWidthMm !== null || printer.labelHeightMm !== null) {
    problems.push({ path: `${at}/dpi`, message: 'An A4 printer has no label stock or resolution.' })
  }
  return problems
}

/** The words a job keeps of a relay's refusal: the relay's own message, or a plain one for anything else. */
export function relayMessage(error: unknown): string {
  const message = error instanceof RelayError ? error.message : 'The print relay could not be reached.'
  return message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX - 3)}...` : message
}

/** A refusal the handler should not try again (a final RelayError). */
export const isFinalRelayError = (error: unknown): boolean => error instanceof RelayError && !error.retryable

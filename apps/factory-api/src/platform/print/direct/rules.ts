import type { PrinterKind } from '../rules'

/**
 * Direct thermal printing (B-W2b-391; LOG-026 "Send ZPL straight to a Zebra-class printer at the station (network printer or
 * browser print); fall back to PDF; no desktop agent to install"), pure.
 *
 * A printer says how its jobs reach it (Printer.mode, B-W2b-367): RELAY (the site's relay, W0's flow: the worker hands the job
 * over), DIRECT (a label printer the station's browser reaches on the local network: the worker leaves the job alone, the
 * station takes it, sends the ZPL itself and says how it went) or PDF (nothing is sent to it: the browser prints a PDF). Live use
 * with real printers waits for the Owner's answer on the printers at the packing station (Q6); until then the FAKE relay and
 * made-up addresses only.
 *
 * A job of a DIRECT printer:  QUEUED ──take──▶ SENT (the station has it; relayJobId `direct:<device or user>`)
 *                                                 ├─report PRINTED──▶ PRINTED
 *                                                 └─report FAILED───▶ FAILED (the station's words) ──retry (W0)──▶ QUEUED
 * Only the station that took a job reports it. A job no station can reach the printer for is printed as a PDF by its module
 * (a carrier label: the shipment's one PDF; carton marks: their PDF; a scan label: POST /print/labels/pdf).
 */

export const PRINTER_MODES = ['DIRECT', 'RELAY', 'PDF'] as const
export type PrinterMode = (typeof PRINTER_MODES)[number]

export const DIRECT_OUTCOMES = ['PRINTED', 'FAILED'] as const
export type DirectOutcome = (typeof DIRECT_OUTCOMES)[number]

/** The prefix of a job's relay id while a station's browser has it. */
export const DIRECT_PREFIX = 'direct:'

/** The station's relay id: the device on the floor, the person in the office. */
export const directRelayId = (holder: { readonly deviceId: string | null; readonly actorId: string }): string => `${DIRECT_PREFIX}${holder.deviceId ?? holder.actorId}`

/**
 * A printer the station's browser reaches: a host name or IPv4 address with an optional port, or an http(s) address (no
 * spaces, no user or password in it). It is where the browser sends the ZPL, never a secret.
 */
const ADDRESS = /^(?:https?:\/\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?(?:\/[^\s@]*)?$/

export const isDirectAddress = (target: string): boolean => target.length <= 200 && !target.includes('@') && ADDRESS.test(target.trim())

/** Why a printer may not take this mode (null: it may), in words. */
export function modeProblem(printer: { readonly kind: PrinterKind; readonly relayTarget: string }, mode: PrinterMode): string | null {
  if (mode === 'DIRECT' && printer.kind !== 'LABEL_ZPL') return 'Only a label printer (ZPL) prints straight from the station; an A4 printer prints through the relay or from the browser.'
  if (mode === 'DIRECT' && !isDirectAddress(printer.relayTarget)) {
    return "Say the printer's address on the local network first (as the station's browser reaches it, e.g. 192.168.1.50 or https://printer.local), then print straight to it."
  }
  return null
}

/** The words a job keeps when the station could not print it (one line, at most 300 characters). */
export function stationFailure(message: string | undefined): string {
  const words = (message ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const text = `The station could not print it: ${words === '' ? 'the printer did not answer.' : words}`
  return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

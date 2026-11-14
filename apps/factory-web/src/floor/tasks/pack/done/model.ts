import type { DocumentsState } from '../model'

/**
 * Packed (B-W2b-387; design floor.pack "Packed": 'Shipment S-0012 packed · 4 cartons · labels printed.'): what the bench
 * says when the packer is done with a shipment, from what really happened — the cartons and their marks, the carrier
 * labels and the DDT with the packing list (printed, on their way, failed, or why they wait) — never a word more. Pure:
 * the container hands the facts, the view words the codes.
 */

/** How a printed part stands: printed, on its way, failed, or not printed yet (it could be). */
type Printing = 'printed' | 'printing' | 'failed' | 'ready'

/** The carrier labels: printing, or why they wait (the office buys them; no label printer here; not the role's) or none. */
export type LabelsDone = Printing | 'office' | 'noPrinter' | 'noRight' | 'notNeeded'

/** The DDT with the packing list: printing, or why they wait (the office issues it; no printer here; its PDF not stored). */
export type DocumentsDone = Printing | 'office' | 'noPrinter' | 'pdfMissing'

export interface PackedSummary {
  readonly number: string
  readonly cartons: number
  /** Every carton's marks say "n of N" now. */
  readonly marks: 'printed' | 'due'
  readonly transportBy: 'SENDER' | 'RECIPIENT' | 'CARRIER'
  readonly labels: LabelsDone
  readonly documents: DocumentsDone
}

export interface DoneJob {
  readonly what: 'LABEL' | 'DDT' | 'PACKING_LIST'
  readonly status: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED'
}

function printedOf(jobs: readonly DoneJob[]): Printing | null {
  if (jobs.length === 0) return null
  if (jobs.some((job) => job.status === 'FAILED')) return 'failed'
  return jobs.every((job) => job.status === 'PRINTED') ? 'printed' : 'printing'
}

export function packedSummary(facts: {
  readonly number: string
  readonly cartons: number
  readonly marksDue: boolean
  readonly transportBy: PackedSummary['transportBy']
  readonly documents: Pick<DocumentsState, 'labels' | 'documents'>
  readonly jobs: readonly DoneJob[]
}): PackedSummary {
  const labelJobs = facts.jobs.filter((job) => job.what === 'LABEL')
  const documentJobs = facts.jobs.filter((job) => job.what !== 'LABEL')
  const labelsHeld = facts.documents.labels.held
  const documentsHeld = facts.documents.documents.held
  const labels: LabelsDone =
    facts.transportBy !== 'CARRIER' || labelsHeld === 'notNeeded'
      ? 'notNeeded'
      : (printedOf(labelJobs) ?? (labelsHeld === 'officeBuys' ? 'office' : labelsHeld === 'noPrinter' ? 'noPrinter' : labelsHeld === 'noRight' ? 'noRight' : 'ready'))
  const documents: DocumentsDone = printedOf(documentJobs) ?? (documentsHeld === 'officeIssues' ? 'office' : documentsHeld === 'noPrinter' ? 'noPrinter' : documentsHeld === 'pdfMissing' ? 'pdfMissing' : 'ready')
  return { number: facts.number, cartons: facts.cartons, marks: facts.marksDue ? 'due' : 'printed', transportBy: facts.transportBy, labels, documents }
}

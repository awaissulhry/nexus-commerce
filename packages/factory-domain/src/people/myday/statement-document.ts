import type { ComposedDocument } from '../../documents/compose'
import type { BusinessDate } from '../../core/time'
import { workerStatementDocument, type WorkerStatementInput } from '../earnings/statement-document'

/**
 * My statement as a PDF (B-W2b-68; design floor.myday new tab "My statement (PDF)"; c.c. art. 2101 c.3): the ONE worker statement
 * (people/earnings/statement-document.ts, B-W2b-62), so the floor and the office print the same document, from the frozen row
 * the office approved. Only APPROVED ones are ever drawn here: the routes refuse the rest.
 */

export type MyStatementInput = Omit<WorkerStatementInput, 'status' | 'on'> & { readonly approvedOn: BusinessDate }

export const myStatementDocument = ({ approvedOn, ...input }: MyStatementInput): ComposedDocument => workerStatementDocument({ ...input, status: 'APPROVED', on: approvedOn })

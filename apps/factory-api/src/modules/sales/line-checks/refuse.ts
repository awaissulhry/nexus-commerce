import { DomainError } from '@nexus/factory-domain/core/errors'
import type { Reader } from '../quotes/store'
import { runLineChecks, type LineCheckDocument, type LineCheckLine } from './index'
import { privateLabelCheck } from './private-label'
import { releasedScopeCheck } from './released-scope'

/**
 * The line rules that keep a line out of a quote being made (B-W2b-294; follow-ups QT1:01 and QT1:02: "Quote lines refuse a
 * colourway or size outside the released scope", "Quotes refuse another customer's private-label style"). A quote started from
 * a template (quote-templates/start.ts) asks them for each line before it writes it: a BLOCKS finding is a 409 in the rule's
 * words, and the start leaves the line out with them. A line typed on a draft is written and its BLOCKS finding stops the
 * quote's send and an office order (the line rules' way, as B-W2b-325's minimums); the Warnings section says why at once.
 */
export const LINE_WRITE_CHECKS = Object.freeze([privateLabelCheck, releasedScopeCheck])

export async function refuseLineRules(db: Reader, document: Omit<LineCheckDocument, 'lines' | 'priceListId'> & { readonly line: LineCheckLine }): Promise<void> {
  const { line, ...rest } = document
  const findings = await runLineChecks(db, { ...rest, priceListId: null, lines: [line] }, LINE_WRITE_CHECKS)
  const blocks = findings.filter((finding) => finding.severity === 'BLOCKS')
  if (blocks.length === 0) return
  throw new DomainError('conflict', blocks[0]!.message, blocks.map((finding) => ({ path: `line-rule/${finding.code}`, message: finding.message })))
}

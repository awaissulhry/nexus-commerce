import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { severalWords } from '@nexus/factory-domain/production/onbehalf/rules'
import { unknownBundleRefusal } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { ScanRefusedError } from '../scans/access'
import { reportScan, type ReportInput, type ScanView } from '../scans/scans'

/**
 * POST /production/several-bundles/finish (B-W2b-47; MES-100; design floor.operation "Several bundles at once": "A stack of
 * scanned bundles with their quantities and a total; 'Finish 3 bundles · 60 good'"). One tap over the stack: each bundle
 * is its own REPORT, one after the other through POST /production/scans's own path (its command, locks, the checks before it
 * counts, the operation's steps, its `components`, the same clientScanId rules). A refused bundle stays on the stack with
 * its words and never stops the others; a held one goes on to the guards' override route on its own. Offline a stack is
 * simply one production.scan.report per bundle, in the queue's order.
 *
 * It starts no timing and relaxes no rule of timed work: a report needs no START (Owner answer F3), and one bundle in a
 * stretch of the subject ends it, as any report does.
 */

export type SeveralItem = Omit<ReportInput, 'occurredAt' | 'override' | 'onBehalf'>

type Refused = { readonly code: string; readonly message: string; readonly fix: string; readonly final: boolean }
type Answer = { readonly clientScanId: string; readonly status: 'accepted' | 'duplicate' | 'refused'; readonly scan: ScanView | null; readonly refusal: Refused | null }

function refusalOf(error: unknown): Refused | null {
  if (error instanceof ScanRefusedError) return error.refusal
  // Online, a wrong label is a 400 and an unknown bundle a 404: on a stack they are one bundle's refusal.
  if (error instanceof DomainError && (error.code === 'not_found' || error.code === 'validation_failed')) return { ...unknownBundleRefusal(), message: error.message }
  return null
}

export async function finishSeveral(caller: CommandCaller, body: { readonly items: readonly SeveralItem[]; readonly occurredAt?: string | undefined }) {
  const ids = body.items.map((item) => item.clientScanId)
  const twice = ids.findIndex((id, index) => ids.indexOf(id) !== index)
  if (twice >= 0) throw new ValidationError('Each bundle of the stack has its own client scan id.', [{ path: `body/items/${twice}/clientScanId`, message: 'Named twice.' }])
  const items: Answer[] = []
  for (const item of body.items) {
    try {
      const { scan, replayed } = await reportScan(caller, { ...item, ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}) })
      items.push({ clientScanId: item.clientScanId, status: replayed ? 'duplicate' : 'accepted', scan, refusal: null })
    } catch (error) {
      const refusal = refusalOf(error)
      if (!refusal) throw error
      items.push({ clientScanId: item.clientScanId, status: 'refused', scan: null, refusal })
    }
  }
  const done = items.flatMap((item) => (item.scan ? [item.scan] : []))
  const sum = (count: (scan: ScanView) => number) => done.reduce((total, scan) => total + count(scan), 0)
  const totals = { finished: done.length, refused: items.length - done.length, good: sum((scan) => scan.goodQuantity), scrap: sum((scan) => scan.scrapQuantity), rework: sum((scan) => scan.reworkQuantity) }
  return { items, ...totals, words: severalWords(totals) }
}

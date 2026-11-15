import { BROKER_PACK_REFUSALS } from '@nexus/factory-domain/shipping/broker-pack/rules'
import { CUSTOMS_REFUSALS, EXPORT_REASONS, mrnOf, type ExportReason } from '@nexus/factory-domain/shipping/customs/rules'
import { words, type Read, type Words } from '../queue/shared/depth'
import type { DispatchAbilities } from '../pickup/dispatch'
import type { BrokerPack, BrokerParty, CustomsDocument, Declaration, ExportRead } from './api'

/**
 * A shipment's Export tab, pure (SCR-653 / SCR-654; design warehouse.shipments record › Export, sec sh-export "destination class
 * (Italy / EU / outside the EU) · Incoterm + named place · commercial invoice (HS codes, origin, values, EORI, weights) · CN22 /
 * CN23 for postal parcels · broker pack link · MRN · proof of exit with a countdown to the alert (art. 8 DPR 633/72)", "Create
 * commercial invoice · Send broker pack (link) · Record MRN", "domestic shipment: 'Not needed: delivered in Italy' and the tab
 * count shows nothing"; tab sh-tab-ci "Commercial invoice PDF"): the tab's state in one word, what holds each action and with
 * which words, the dialogs' fields and their problems.
 */

export { BROKER_PACK_REFUSALS, CUSTOMS_REFUSALS, EXPORT_REASONS }
export const NOTES_MAX = 1000
export const COMMENTS_MAX = 300
export const REASON_TEXT_MAX = 200
export const REMOVE_REASON_MAX = 500

/** The export's state in one word (the card's Pill). */
export function exportState(read: ExportRead): 'notNeeded' | 'unknown' | 'papers' | 'declare' | 'PACK_SENT' | 'FILED' | 'EXITED' | 'overdue' {
  if (!read.needed) return read.destination.class === null ? 'unknown' : 'notNeeded'
  const declaration = read.declaration
  if (!declaration) return read.papers.commercialInvoice.length === 0 ? 'papers' : 'declare'
  if (declaration.overdue) return 'overdue'
  return declaration.status
}

export const STATE_TONE = { notNeeded: 'neutral', unknown: 'warning', papers: 'warning', declare: 'info', PACK_SENT: 'info', FILED: 'info', EXITED: 'success', overdue: 'danger' } as const

const refusal = (code: string | null | undefined): Words => words(`export.refusal.${code ?? 'KEPT'}`)

/** Why Create commercial invoice / a new version is held (null: it may be made). */
export function invoiceHeld(read: ExportRead, can: Pick<DispatchAbilities, 'customs' | 'price'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (!can.price || !read.seesValues) return words('export.held.noPrice')
  if (read.papers.held) return refusal(read.papers.held)
  if (busy) return words('export.held.busy')
  return null
}

/** Why a CN 22 / CN 23 is held (null: it may be made). */
export function postalHeld(read: ExportRead, can: Pick<DispatchAbilities, 'customs' | 'price'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (!can.price || !read.seesValues) return words('export.held.noPrice')
  if (read.papers.postalForm.held) return refusal(read.papers.postalForm.held)
  if (busy) return words('export.held.busy')
  return null
}

/** The CN forms a person may choose: CN 23 always, CN 22 only when the parcels fit it. */
export const postalChoices = (read: ExportRead): readonly ('CN22' | 'CN23')[] => (read.papers.postalForm.suggested === 'CN22' ? ['CN22', 'CN23'] : ['CN23'])

/** Why Open the declaration is held (null: it may be opened). */
export function openHeld(read: ExportRead, can: Pick<DispatchAbilities, 'customs'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (read.declarationHeld) return refusal(read.declarationHeld)
  if (busy) return words('export.held.busy')
  return null
}

/** Why Record MRN is held. */
export function mrnHeld(declaration: Declaration, read: ExportRead, can: Pick<DispatchAbilities, 'customs'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (declaration.mrn) return refusal('MRN_KEPT')
  if (busy) return words('export.held.busy')
  return null
}

/** Why Name the invoice is held. */
export function nameInvoiceHeld(declaration: Declaration, read: ExportRead, can: Pick<DispatchAbilities, 'customs'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (declaration.invoice) return refusal('INVOICE_KEPT')
  if (declaration.status === 'EXITED') return refusal('EXITED')
  if (read.invoices.length === 0) return words('export.held.noInvoices')
  if (busy) return words('export.held.busy')
  return null
}

/** Why Proof of exit is held. */
export function exitHeld(declaration: Declaration, read: ExportRead, can: Pick<DispatchAbilities, 'customs' | 'uploadFiles'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (declaration.status === 'EXITED') return refusal('EXITED')
  if (!declaration.mrn) return refusal('NOT_FILED')
  if (!declaration.invoice) return refusal('NO_INVOICE')
  if (!read.shipment.shippedAt) return refusal('NOT_LEFT')
  if (!can.uploadFiles) return words('export.held.noUpload')
  if (busy) return words('export.held.busy')
  return null
}

/** Why Remove (sent by mistake) is held. */
export function removeHeld(declaration: Declaration, read: ExportRead, can: Pick<DispatchAbilities, 'customs'>, busy: boolean): Words | null {
  if (!can.customs || !read.mayManage) return words('export.held.noRight')
  if (declaration.status !== 'PACK_SENT') return refusal(declaration.status === 'EXITED' ? 'EXITED' : 'KEPT')
  if (busy) return words('export.held.busy')
  return null
}

/** Why Send broker pack (the pack dialog) is held. */
export function packHeld(read: ExportRead, busy: boolean): Words | null {
  if (!read.declaration) return words('export.held.openFirst')
  if (busy) return words('export.held.busy')
  return null
}

/** Why the pack's link is held: the API's code (the site's switch off, no broker, …), the price grain, the right. */
export function linkHeld(pack: BrokerPack, can: Pick<DispatchAbilities, 'customs' | 'price'>, busy: boolean): Words | null {
  if (!can.customs) return words('export.held.noRight')
  if (pack.linkHeld) return words(`export.packRefusal.${pack.linkHeld}`)
  if (!can.price) return words('export.packRefusal.PRICE_GRAIN')
  if (busy) return words('export.held.busy')
  return null
}

/** Why the pack's merged PDF is held. */
export function downloadHeld(pack: BrokerPack, can: Pick<DispatchAbilities, 'price'>): Words | null {
  if (pack.downloadHeld) return words(`export.packRefusal.${pack.downloadHeld}`)
  if (!can.price) return words('export.packRefusal.PRICE_GRAIN')
  return null
}

/** The countdown to the exit's alert (art. 8 DPR 633/72), in words. */
export function exitClock(declaration: Declaration): { words: Words; tone: 'success' | 'info' | 'warning' | 'danger' } | null {
  if (declaration.status === 'EXITED') return null
  if (declaration.daysLeft === null) return { words: words('export.clock.notLeft', { days: declaration.alertAfterDays }), tone: 'info' }
  if (declaration.overdue) return { words: words('export.clock.overdue', { days: Math.abs(declaration.daysLeft) }), tone: 'danger' }
  return { words: words('export.clock.left', { days: declaration.daysLeft }), tone: declaration.daysLeft <= 5 ? 'warning' : 'info' }
}

/** A paper's line: kind, version, language, when (the newest marked). */
export const documentLabel = (document: CustomsDocument): Words => words(`export.paper.${document.kind}`, { version: document.version })

/** The window of a customs paper's PDF (a new tab: a customs document for the broker). */
export const paperHref = (prefix: string, shipmentId: string, documentId: string): string => `${prefix}/warehouse/shipments/customs-paper?shipment=${encodeURIComponent(shipmentId)}&document=${encodeURIComponent(documentId)}`

// ---- the dialogs ----------------------------------------------------------------------------------------------------------------

export type ExportDialog =
  | null
  | { readonly kind: 'invoice'; readonly language: '' | 'it' | 'en'; readonly reason: ExportReason; readonly reasonText: string; readonly notes: string }
  | { readonly kind: 'postal'; readonly form: 'CN22' | 'CN23'; readonly language: '' | 'it' | 'en'; readonly reason: ExportReason; readonly reasonText: string; readonly comments: string }
  | { readonly kind: 'declaration'; readonly brokerPartyId: string; readonly alertAfterDays: number }
  | { readonly kind: 'mrn'; readonly mrn: string }
  | { readonly kind: 'nameInvoice'; readonly invoiceId: string }
  | { readonly kind: 'exit'; readonly at: string; readonly file: File | null; readonly fileName: string | null }
  | { readonly kind: 'remove'; readonly reason: string }
  | { readonly kind: 'pack'; readonly origin: readonly string[] }

/** What a dialog still misses, in words (null: it may be sent). */
export function dialogProblem(dialog: Exclude<ExportDialog, null>, read: ExportRead, now: number = Date.now()): Words | null {
  switch (dialog.kind) {
    case 'invoice':
    case 'postal':
      if (dialog.reason === 'OTHER' && dialog.reasonText.trim() === '') return words('export.problem.reasonText')
      return null
    case 'declaration':
      if (!Number.isInteger(dialog.alertAfterDays) || dialog.alertAfterDays < read.alertDays.min || dialog.alertAfterDays > read.alertDays.max) return words('export.problem.alertDays', { min: read.alertDays.min, max: read.alertDays.max })
      return null
    case 'mrn':
      if (dialog.mrn.trim() === '') return words('export.problem.mrnEmpty')
      return mrnOf(dialog.mrn) ? null : words('export.problem.mrn')
    case 'nameInvoice':
      return dialog.invoiceId ? null : words('export.problem.invoice')
    case 'exit': {
      const at = Date.parse(dialog.at)
      if (!dialog.at || Number.isNaN(at)) return words('export.problem.exitAt')
      if (at > now + 5 * 60_000) return refusal('EXIT_TIME')
      if (read.shipment.shippedAt && at < Date.parse(read.shipment.shippedAt)) return refusal('EXIT_TIME')
      return dialog.file ? null : words('export.problem.exitFile')
    }
    case 'remove':
      return dialog.reason.trim() === '' ? words('export.problem.removeReason') : null
    case 'pack':
      return null
  }
}

export interface ExportPapersModel {
  readonly read: Read<ExportRead>
  readonly can: Pick<DispatchAbilities, 'customs' | 'price' | 'uploadFiles' | 'readFiles' | 'viewParties' | 'settingsView'>
  readonly dialog: ExportDialog
  readonly busy: boolean
  readonly problem: Words | null
  /** The last write, in words. */
  readonly done: Words | null
  /** The brokers a declaration may name (parties.view); null: not read (no right, or not asked yet). */
  readonly brokers: Read<readonly BrokerParty[]> | null
  /** The broker's pack, while its dialog is open. */
  readonly pack: Read<BrokerPack> | null
  /** The pack as one PDF, when asked. */
  readonly packPdf: Read<Uint8Array> | null
  /** A link to pass on, shown once. */
  readonly passOn: string | null
  readonly prefix: string
}

export interface ExportPapersActions {
  onRetry?: () => void
  onDialog?: (dialog: ExportDialog) => void
  onGo?: () => void
  onPackPdf?: (open: boolean) => void
  onPackLink?: (send: boolean) => void
  onDismiss?: () => void
}

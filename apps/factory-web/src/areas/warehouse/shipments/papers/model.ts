import { words, type DepthAbilities, type Read, type Words } from '../queue/shared/depth'
import type { DocumentLanguage, Pack, PackPart, Proformas } from './api'

/**
 * The shipment's papers, pure (SCR-596; design sh-docs-other "Packing list (LOG-012), proforma (W2b), generated documents
 * with versions · Print all (one merged PDF in a new tab)", sh-doc-conf "attached file or the public DoC link (links.doc,
 * W2b)"): the view model of the card, what holds each button, a part's state in words.
 */

/** The notes a proforma prints (factory-domain shipping/proforma PROFORMA_NOTES_MAX; that module reads node's crypto). */
export const PROFORMA_NOTES_MAX = 1000

/** A style of the shipment with its public DoC page (the address and, for a reader with the compliance right, whether it shows a declaration today). */
export interface PublicDoc {
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly code: string
  readonly address: string
  /** null: not known to this reader (no compliance right). */
  readonly live: boolean | null
}

export interface PapersModel {
  readonly number: string
  readonly status: string
  /** The pack (shipping.pack; null: not for this person). */
  readonly pack: Read<Pack> | null
  /** The proforma (shipping.proforma.issue + the price grain; null: not for this person). */
  readonly proformas: Read<Proformas> | null
  readonly docs: Read<readonly PublicDoc[]>
  readonly can: Pick<DepthAbilities, 'pack' | 'printDocuments' | 'readFiles' | 'proforma' | 'price'>
  /** The merged PDF shown in the viewer (its version), while open. */
  readonly pdf: null | { readonly version: number | null; readonly data: Uint8Array | null; readonly problem: Words | null }
  readonly dialog: null | { readonly kind: 'proforma'; readonly language: DocumentLanguage | null; readonly notes: string }
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
}

export interface PapersActions {
  onRetry?: () => void
  onMakePack?: (print: boolean) => void
  onOpenPdf?: (version: number | null) => void
  onClosePdf?: () => void
  onDialog?: (dialog: PapersModel['dialog']) => void
  onMakeProforma?: () => void
  onOpenProforma?: (fileId: string) => void
  onCopy?: (address: string) => void
}

/** A part's line: ready (number, files), missing (why, by its kind), none (not needed), not shown (priced). */
export function partWords(part: PackPart): Words {
  if (part.state === 'READY') return part.number ? words('pack.ready.numbered', { number: part.number, count: part.files }) : words('pack.ready.files', { count: part.files })
  if (part.state === 'MISSING') return words(`pack.missing.${part.kind}`)
  if (part.state === 'NONE') return words(`pack.none.${part.kind}`)
  return words('pack.notShown')
}
export const PART_TONE = { READY: 'success', MISSING: 'warning', NONE: 'neutral', NOT_SHOWN: 'neutral' } as const

/** Why "Make and print" / "Make the PDF" is held. */
export function packHeld(model: Pick<PapersModel, 'can' | 'busy' | 'status'>, pack: Pack, print: boolean): Words | null {
  if (!model.can.pack) return words('pack.held.noPack')
  if (model.status === 'CANCELLED') return words('pack.held.cancelled')
  if (!pack.parts.some((part) => part.state === 'READY')) return words('pack.held.nothing')
  if (print && !model.can.printDocuments && pack.printer) return words('pack.held.noPrint')
  if (print && !pack.printer) return words('pack.held.noPrinter')
  if (model.busy) return words('pack.held.busy')
  return null
}

/** Why "Open the PDF" is held. */
export function openHeld(pack: Pack, busy: boolean): Words | null {
  if (!pack.latest) return words('pack.held.notMade')
  if (busy) return words('pack.held.busy')
  return null
}

/** The proforma's blockers in this step's words (the API's sentences mapped to kinds, each once). */
export function proformaBlockers(problems: readonly string[]): Words[] {
  const kinds = new Set<string>()
  for (const problem of problems) {
    if (/cancelled/i.test(problem)) kinds.add('cancelled')
    else if (/no garments|nothing to put/i.test(problem)) kinds.add('noLines')
    else if (/price/i.test(problem)) kinds.add('noPrice')
    else if (/VAT/.test(problem)) kinds.add('vat')
    else if (/currency/i.test(problem)) kinds.add('currency')
    else kinds.add('other')
  }
  return [...kinds].map((kind) => words(`proforma.problem.${kind}`))
}

/** Why "Make a proforma" is held. */
export function proformaHeld(model: Pick<PapersModel, 'can' | 'busy'>, proformas: Proformas): Words | null {
  if (!model.can.proforma || !model.can.price) return words('proforma.held.noRight')
  if (proformas.problems.length > 0) return words('proforma.held.problems', { count: proformaBlockers(proformas.problems).length })
  if (model.busy) return words('proforma.held.busy')
  return null
}

import type { CommerceImportView, StartedStylesView } from '@nexus/factory-domain/product/commerce-import/source'
import { isApiError } from '../../../../../lib/api/errors'
import type { ImportRights } from '../../../../admin/import/model'

/**
 * New style › "Nexus Commerce product" and the styles header's Import (B-W2b-209; PRD-265; design products.styles
 * pop:styles.new "Start from … Nexus Commerce product (W2b)", page.h "Import (W2b: from Nexus Commerce or a sheet)"):
 *
 *   source   where the styles start from: a Commerce export file (or a sheet in its columns), chosen; reading Commerce
 *            live, held: OFF until the Owner's word (the server says so: GET /product/commerce-import). What the
 *            import makes, and that nothing goes back to Commerce. Continue opens the import (upload → dry run → apply).
 *   (import) Admin › Import & export's wizard on the one importer `product.commerceStyles` (../sheet-import).
 *   done     after an apply: the styles the file started (new drafts in Concept) or added to, with Open; reading them
 *            is `GET /product/commerce-import/jobs/:jobId`.
 *
 * Pure: the screen's state and its words' keys (catalogue `products-commerce-import`).
 */

export type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface CommerceImportModel {
  step: 'source' | 'done'
  info: Read<CommerceImportView>
  /** Why Continue is held (a key), null when it is not. */
  held: string | null
  /** The job whose styles the done step shows. */
  done: { jobId: string; styles: Read<StartedStylesView> } | null
}

/** What the person may do: start styles (product.styles.manage) and import a file (imports.run and files.upload). */
export interface CommerceRights {
  manage: boolean
  imports: Pick<ImportRights, 'run' | 'apply'>
}

/** Why the import cannot start for this person, or null. Applying is the wizard's own hold (imports.apply). */
export function commerceHeld(rights: CommerceRights): string | null {
  if (!rights.manage) return 'hold.noManage'
  if (!rights.imports.run) return 'hold.noImport'
  return null
}

/** Continue on the source step: held by the rights first, then while the sources are read or could not be. */
export function continueHeld(model: CommerceImportModel): string | null {
  if (model.held) return model.held
  if (model.info.status === 'loading') return 'hold.reading'
  if (model.info.status === 'error') return 'hold.unread'
  return null
}

/** The live read's words: the reason the server gives for keeping it OFF. */
export const liveReasonKey = (info: CommerceImportView): string => {
  const live = info.sources.find((source) => source.source === 'LIVE_READ')
  return live?.state === 'ON' ? 'source.live.on' : `source.live.reason.${live?.reasonCode ?? 'OWNER_WORD'}`
}

/** A problem of a read, as a key of this catalogue (never the API's message). */
export function readProblemKey(error: unknown): string {
  if (!isApiError(error)) return 'fault.internal'
  switch (error.kind) {
    case 'signed_out':
    case 'forbidden':
    case 'not_found':
    case 'unavailable':
    case 'rate_limited':
      return `fault.${error.kind}`
    default:
      return 'fault.internal'
  }
}

/** The done step's one style to open straight away: the only style the file started, else none. */
export function onlyStarted(view: StartedStylesView): StartedStylesView['styles'][number] | null {
  return view.styles.length === 1 ? view.styles[0]! : null
}

export interface CommerceImportActions {
  onClose?: () => void
  onContinue?: () => void
  onRetry?: () => void
}

import { isApiError, issuePath } from '../../lib/api/errors'
import { RETURN_LABEL_REFUSALS, type ReturnLabelRefusal } from '@nexus/factory-domain/shipping/return-labels/rules'
import type { LinkState } from '../../shell/links/link-state'
import type { ReturnLabelPage } from './api'

/** The customer's return label page's rules (B-W2b-398; SCR-436), pure: its state and the words of a refusal (catalogue `shipping-delivery`, keys `link.*`). */

export interface ReturnLabelLinkModel {
  readonly link: LinkState
  readonly page: ReturnLabelPage | null
  readonly busy: null | 'book' | 'download'
  /** A key of the catalogue: what went wrong with the last press. */
  readonly problem: string | null
  readonly offline: boolean
}

export interface ReturnLabelLinkActions {
  readonly onRetry?: () => void
  readonly onBook?: () => void
  readonly onDownload?: () => void
}

export const initialLinkModel: ReturnLabelLinkModel = { link: 'valid', page: null, busy: null, problem: null, offline: false }

const isRefusal = (value: string): value is ReturnLabelRefusal => (RETURN_LABEL_REFUSALS as readonly string[]).includes(value)

/** Why Book is held (a key), or null. */
export function bookHeldKey(model: Pick<ReturnLabelLinkModel, 'page' | 'busy' | 'offline'>): string | null {
  const page = model.page
  if (!page || page.label.status !== 'OFFERED') return null
  if (page.bookHeld) return `link.held.${page.bookHeld}`
  if (model.offline) return 'link.held.offline'
  if (model.busy !== null) return 'link.held.busy'
  return null
}

/** Why Download is held (a key), or null. */
export function downloadHeldKey(model: Pick<ReturnLabelLinkModel, 'page' | 'busy' | 'offline'>): string | null {
  if (!model.page?.label.hasPdf) return 'link.held.notBooked'
  if (model.offline) return 'link.held.offline'
  if (model.busy !== null) return 'link.held.busy'
  return null
}

/** A failed press in words (a key), and whether the link itself stopped opening. */
export function pressProblem(error: unknown): { readonly key: string; readonly link: LinkState | null } {
  if (isApiError(error)) {
    if (error.kind === 'not_found') return { key: 'link.problem.gone', link: 'unavailable' }
    const code = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))?.slice('refusal/'.length)
    if (code && isRefusal(code)) return { key: `link.held.${code}`, link: null }
    if (error.kind === 'unavailable') return { key: 'link.held.offline', link: null }
  }
  return { key: 'link.problem.failed', link: null }
}

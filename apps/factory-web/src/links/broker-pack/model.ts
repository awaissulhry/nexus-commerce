import { BROKER_LINK_REFUSALS, type BrokerLinkRefusal } from '@nexus/factory-domain/shipping/broker-pack/rules'
import { mrnOf } from '@nexus/factory-domain/shipping/customs/rules'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { BrokerPackPage } from './api'

/** The broker's page's rules (B-W2b-409; SCR-580), pure: its state, what holds a press, a refusal in words (catalogue `broker-pack`). */

export interface BrokerPackLinkModel {
  readonly link: LinkState
  readonly page: BrokerPackPage | null
  /** What is being sent: the MRN, or the download of one paper (its file id). */
  readonly busy: null | 'mrn' | { readonly download: string }
  /** The MRN as typed. */
  readonly mrn: string
  /** A key of the catalogue: what went wrong with the last press. */
  readonly problem: string | null
  readonly offline: boolean
}

export interface BrokerPackLinkActions {
  readonly onRetry?: () => void
  readonly onMrn?: (value: string) => void
  readonly onSend?: () => void
  readonly onDownload?: (fileId: string) => void
}

export const initialBrokerModel: BrokerPackLinkModel = { link: 'valid', page: null, busy: null, mrn: '', problem: null, offline: false }

const isRefusal = (value: string): value is BrokerLinkRefusal => (BROKER_LINK_REFUSALS as readonly string[]).includes(value)

/** Filed: the MRN is recorded (by this page, or typed in by our office). */
export const filedOf = (page: BrokerPackPage | null): boolean => page !== null && page.declaration.mrn !== null

/** What is wrong with the MRN as typed (a key), or null; nothing typed yet is no problem. */
export function mrnProblemKey(typed: string): string | null {
  if (typed.trim() === '') return null
  return mrnOf(typed) ? null : 'held.MRN_FORMAT'
}

/** Why Send is held (a key), or null. */
export function sendHeldKey(model: Pick<BrokerPackLinkModel, 'page' | 'busy' | 'offline' | 'mrn'>): string | null {
  if (filedOf(model.page)) return 'held.FILED'
  if (model.mrn.trim() === '') return 'held.empty'
  if (mrnProblemKey(model.mrn)) return 'held.MRN_FORMAT'
  if (model.offline) return 'held.offline'
  if (model.busy !== null) return 'held.busy'
  return null
}

/** Why a paper's Download is held (a key), or null. */
export function downloadHeldKey(model: Pick<BrokerPackLinkModel, 'busy' | 'offline'>, paper: { readonly available: boolean }): string | null {
  if (!paper.available) return 'held.gone'
  if (model.offline) return 'held.offline'
  if (model.busy !== null) return 'held.busy'
  return null
}

/** A failed press in words (a key), and whether the link itself stopped opening. */
export function pressProblem(error: unknown): { readonly key: string; readonly link: LinkState | null } {
  if (isApiError(error)) {
    if (error.kind === 'not_found') return { key: 'problem.gone', link: 'unavailable' }
    const code = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))?.slice('refusal/'.length)
    if (code && isRefusal(code)) return { key: `held.${code}`, link: null }
    if (error.issues.map(issuePath).includes('body/mrn')) return { key: 'held.MRN_FORMAT', link: null }
    if (error.kind === 'unavailable') return { key: 'held.offline', link: null }
  }
  return { key: 'problem.failed', link: null }
}

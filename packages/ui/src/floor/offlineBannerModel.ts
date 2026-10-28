/**
 * DS floor kit — what the offline banner says (gap G2, A2 §3.1 "Offline").
 *
 * Every floor action is saved on the tablet first and sent after. The banner stays while that matters to the operator:
 *   offline           warning, always shown: the work is safe here and waiting to be sent;
 *   refused           danger: the office refused some actions — the sync queue (SCR-023) says why;
 *   sending           info: online, some actions still on their way;
 *   synced            success: online and nothing waiting — hidden unless the screen asks for it.
 * Offline outranks refused: with no connection the operator cannot fix a refusal now anyway, and both counts still show.
 */

export type OfflineBannerKind = 'offline' | 'refused' | 'sending' | 'synced'
export type OfflineBannerTone = 'warning' | 'danger' | 'info' | 'success'

export interface OfflineBannerInput {
  online: boolean
  /** Actions saved on the tablet, not yet accepted by the office. */
  pending: number
  /** Actions the office refused. */
  refused?: number
  /** Show the quiet "all sent" line too. Default false: the banner leaves once nothing is waiting. */
  showWhenSynced?: boolean
}

export interface OfflineBannerState {
  kind: OfflineBannerKind
  tone: OfflineBannerTone
  visible: boolean
  pending: number
  refused: number
}

const count = (n: number | undefined) => (Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0)

export function offlineBannerState({ online, pending, refused, showWhenSynced = false }: OfflineBannerInput): OfflineBannerState {
  const p = count(pending)
  const r = count(refused)
  if (!online) return { kind: 'offline', tone: 'warning', visible: true, pending: p, refused: r }
  if (r > 0) return { kind: 'refused', tone: 'danger', visible: true, pending: p, refused: r }
  if (p > 0) return { kind: 'sending', tone: 'info', visible: true, pending: p, refused: r }
  return { kind: 'synced', tone: 'success', visible: showWhenSynced, pending: 0, refused: 0 }
}

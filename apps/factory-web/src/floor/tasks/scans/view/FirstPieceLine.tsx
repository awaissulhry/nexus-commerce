'use client'

import { CircleCheckBig, Hourglass, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { Translate } from '../../../../lib/i18n/messages'
import { TaskLine } from '../../shared/view/TaskParts'
import { firstPieceAt } from '../first-piece'
import type { BundleCard } from '../model'

/**
 * B-W2b-105 (QHS-039; design floor.operation bundle-card "Flags with icon + word: … Waiting first-piece approval (W2b, held)"): the
 * first-piece flag on the bundle card, beside Rush — icon and words, never colour alone. Held: why and what to do (the inspector or
 * the team leader approves; the first bundle itself is worked). Approved while on screen: the success line (the live lift).
 */
export function FirstPieceLine({ card, operationId, lifted, t }: { card: BundleCard; operationId: string | null; lifted: boolean; t: Translate }) {
  const state = firstPieceAt(card, operationId)
  if (state === 'held' || state === 'rejected') {
    return (
      <TaskLine tone="danger" icon={state === 'rejected' ? <ShieldAlert /> : <Hourglass />}>
        <strong>{t(state === 'rejected' ? 'firstPiece.rejected' : 'firstPiece.held')}</strong> {t('firstPiece.why', { number: card.workOrder.number })} {t('firstPiece.fix')}
      </TaskLine>
    )
  }
  if (state === 'firstBundle') {
    return (
      <TaskLine tone="info" icon={<ShieldCheck />}>
        {t('firstPiece.firstBundle')}
      </TaskLine>
    )
  }
  if (lifted) {
    return (
      <TaskLine tone="success" icon={<CircleCheckBig />}>
        {t('firstPiece.lifted')}
      </TaskLine>
    )
  }
  return null
}

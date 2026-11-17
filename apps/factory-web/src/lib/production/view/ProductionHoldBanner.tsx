'use client'

import type { ReactNode } from 'react'
import { PauseCircle, ShieldAlert } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { holdView, mostSerious, type Face, type HoldInput } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface ProductionHoldBannerProps {
  face: Face
  /** Every hold on the record; the banner shows the most serious and counts the rest. */
  holds: readonly HoldInput[]
  /** The office's action (Release the hold, Lift the hold), held with its reason by the caller. Never a dismiss on a live hold. */
  action?: ReactNode
}

/**
 * F-PR-01 — one hold banner per page, the most serious (09-design §1.7; R12: one banner, others counted), drawn with the
 * DS Banner: a quality hold in the danger tone, a production hold or a pause in the warning tone. Office: "On hold since
 * 14 Nov · Quality: shade difference" and when it goes back to In progress. Customer: curated words only — "Paused at
 * your request since 14 Nov", or "On hold since 14 Nov: Extra quality checks. We tell you when it continues." No hold:
 * nothing drawn.
 */
export function ProductionHoldBanner({ face, holds, action }: ProductionHoldBannerProps) {
  const w = useProductionWords()
  const { hold, more } = mostSerious(holds)
  if (!hold) return null
  const view = holdView(face, hold, w.day(hold.since))
  const body = [view.body ? w.say(view.body) : null, more > 0 ? w.t('parts.hold.more', { count: more }) : null].filter((line): line is string => !!line)
  return (
    <Banner
      tone={view.tone}
      icon={hold.kind === 'QUALITY' ? <ShieldAlert size={18} aria-hidden /> : <PauseCircle size={18} aria-hidden />}
      title={w.say(view.title)}
      action={action}
    >
      {body.length > 0 ? body.join(' · ') : null}
    </Banner>
  )
}

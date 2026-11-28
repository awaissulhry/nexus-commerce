'use client'

import { Camera, Check, Info, ShieldCheck, Undo2 } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import type { Department } from '../../../lib/department/model'
import { useT } from '../../../lib/i18n/provider'
import type { QualityStep } from '../api'
import type { QualityProgress } from '../model'
import { BASKET_NS } from '../parts'
import '../basket.css'

/**
 * owb-fl5 step 3 (design § 1 row 6, § 5zf B "Quality check"; P/fplus.js qcCard) — at Quality, while the basket is worked on: the
 * points to tick and the photos to take (today's checklist steps of the operation; a photo step is proved by its photo), "n / m",
 * "Keep faces out of the picture.", and "Not good: send back to <previous>" (a BACK move, reason Work again). "Passed" in the dock
 * waits for all of them. A step done is a ticked word, no longer a button; a tick goes on the phone first (offline too), a photo needs the network.
 */
export interface QcCardModel {
  readonly steps: readonly QualityStep[]
  readonly progress: QualityProgress
  /** The step it goes back to (null: no send back here: none before, or not allowed). */
  readonly back: { readonly dept: Department | null; readonly name: string } | null
  readonly busy: boolean
}

export type QcAction = { readonly type: 'tick'; readonly code: string } | { readonly type: 'photo'; readonly code: string } | { readonly type: 'sendBack' }

export function QcCard({ model, onAction }: { readonly model: QcCardModel; readonly onAction: (action: QcAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = model.busy ? tb('homePage.loading') : null
  return (
    <section className="fw-bk-qc" aria-labelledby="fw-bk-qc-title">
      <div className="fw-bk-qc-head">
        <span id="fw-bk-qc-title" className="fw-bk-flags">
          <ShieldCheck aria-hidden="true" />
          {tb('qc.title')}
        </span>
        <span className="fw-bk-flag" data-tone={model.progress.complete ? 'success' : undefined}>
          <bdi>{tb('qc.count', { done: model.progress.done, total: model.progress.total })}</bdi>
        </span>
      </div>
      <div className="fw-bk-qc-grid">
        {model.steps.map((step) =>
          step.done ? (
            <span key={step.code} className="fw-bk-flag fw-bk-qc-done" data-tone="success">
              <Check aria-hidden="true" />
              {step.photo ? tb('qc.photo', { words: step.words }) : step.words}
              <span className="nds-vh">{tb('qc.ticked')}</span>
            </span>
          ) : (
            <FloorButton key={step.code} size="md" variant="secondary" icon={step.photo ? <Camera /> : <ShieldCheck />} heldReason={held} onClick={() => onAction({ type: step.photo ? 'photo' : 'tick', code: step.code })}>
              {step.photo ? tb('qc.photo', { words: step.words }) : step.words}
            </FloorButton>
          ),
        )}
      </div>
      <p className="fw-bk-muted">
        <Info aria-hidden="true" /> {tb('qc.noFace')}
      </p>
      {model.back ? (
        <FloorButton size="md" variant="danger" block icon={<Undo2 className="fw-bk-mirror" />} heldReason={held} onClick={() => onAction({ type: 'sendBack' })}>
          {tb('dock.sendBack', { dept: model.back.dept ? `${model.back.dept.no} ${model.back.dept.shortName}` : model.back.name })}
        </FloorButton>
      ) : null}
    </section>
  )
}

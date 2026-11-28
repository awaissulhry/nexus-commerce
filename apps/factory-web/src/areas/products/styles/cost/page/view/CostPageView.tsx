'use client'

import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Banner, Card, Disclosure } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import { BySizeCard } from '../../bysize/view/BySizeCard'
import { CostStepsCard } from '../../components/view/CostStepsCard'
import { TargetPriceCard } from '../../goalseek/view/TargetPriceCard'
import { CostNowCard, type CostNowModel } from '../../now/view/CostNowCard'
import { KeepWindow, type KeepWindowModel } from '../../now/view/KeepWindow'
import { PriceCard, type PriceCardModel } from '../../now/view/PriceCard'
import type { Words } from '../../now/model'
import { SizeMixCard } from '../../sizemix/view/SizeMixCard'
import { VersionsCard } from '../../versions/view/VersionsCard'
import type { CostSheetsActions, CostSheetsModel } from '../../versions/view/CostSheetsView'
import { WhatIfCard, type WhatIfModel } from '../../whatif/view/WhatIfCard'
import type { WhatIfInput } from '../../whatif/model'
import '../../../styles.css'
import '../../versions/cost-sheets.css'
import '../../now/cost.css'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh, in its order) — the product tab "Cost", for the cost grain only: the line on top (standard
 * cost against the cost now, the difference, how many agreed prices are under the target) · Cost of one piece, now (the bar of 4 parts
 * and how each is worked out; "Keep … as the standard cost…", "The factory's rates…") · Price against cost · By size and What if side by
 * side where the room is wide · Standard cost, kept (the versions and their approval). ONE closed "More" keeps today's depth, nothing
 * lost: the other costs step by step, the target price of a version, the size mix, and the sheet line by line with its material prices
 * and rates. Draws its model; fetches nothing (../CostPage.tsx).
 */

export interface CostPageModel {
  readonly top: readonly Words[]
  /** A released revision: its material list and route are frozen; prices, rates and other costs move at any time. */
  readonly frozen: { readonly revision: number } | null
  readonly notice: Words | null
  readonly now: CostNowModel
  readonly price: PriceCardModel
  readonly whatIf: WhatIfModel | null
  readonly keep: KeepWindowModel | null
  readonly sheets: CostSheetsModel
}

export interface CostPageActions {
  readonly onKeepOpen: () => void
  readonly onKeepReason: (text: string) => void
  readonly onKeep: () => void
  readonly onKeepClose: () => void
  readonly onRetryNow: () => void
  readonly onRetryPrice: () => void
  readonly onWhatIf: (input: WhatIfInput) => void
  readonly onWhatIfClear: () => void
  readonly sheets?: CostSheetsActions
}

export function CostPageView({ model, actions, ratesDoor, detail }: { model: CostPageModel; actions: CostPageActions; ratesDoor?: ReactNode; detail?: ReactNode }) {
  const t = useT('products-cost')
  const say = (words: Words) => t(words.key, words.params)
  const { sheets } = model
  return (
    <div className="fw-ct-room">
      <div className="fw-ct fw-cs">
        <Card padded>
          <div className="fw-ct-body">
            <p className="fw-ct-top">{model.top.map(say).join(' ')}</p>
            {model.frozen && (
              <p className="fw-ct-note">
                <Lock size={14} aria-hidden /> {t('top.frozen', { revision: model.frozen.revision })}
              </p>
            )}
          </div>
        </Card>
        {model.notice && <Banner tone="success" title={say(model.notice)} />}

        <CostNowCard model={model.now} onKeep={actions.onKeepOpen} onRetry={actions.onRetryNow} ratesDoor={ratesDoor} />
        <PriceCard model={model.price} onRetry={actions.onRetryPrice} />

        <div className="fw-ct-pair">
          {sheets.bySize && <BySizeCard model={sheets.bySize} actions={actions.sheets?.bySize} />}
          {model.whatIf && <WhatIfCard model={model.whatIf} onInput={actions.onWhatIf} onClear={actions.onWhatIfClear} />}
        </div>

        {sheets.versions && <VersionsCard model={sheets.versions} actions={actions.sheets?.versions} />}

        <Disclosure summary={t('more.summary')}>
          <div className="fw-ct">
            {sheets.steps && <CostStepsCard model={sheets.steps} actions={actions.sheets?.steps} />}
            {sheets.goal && <TargetPriceCard key={sheets.goal.sheet?.id ?? 'none'} model={sheets.goal} actions={actions.sheets?.goal} />}
            {sheets.sizeMix && <SizeMixCard model={sheets.sizeMix} actions={actions.sheets?.sizeMix} />}
            {detail}
          </div>
        </Disclosure>
      </div>

      {model.keep && <KeepWindow model={model.keep} onReason={actions.onKeepReason} onKeep={actions.onKeep} onClose={actions.onKeepClose} />}
    </div>
  )
}

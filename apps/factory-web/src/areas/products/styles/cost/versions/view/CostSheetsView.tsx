'use client'

import { WithMessages } from '../../../../../../record-panels/i18n'
import { BySizeCard, type BySizeActions, type BySizeModel } from '../../bysize/view/BySizeCard'
import { CostStepsCard, type CostStepsActions, type CostStepsModel } from '../../components/view/CostStepsCard'
import { TargetPriceCard, type TargetPriceActions, type TargetPriceModel } from '../../goalseek/view/TargetPriceCard'
import { CS_NS } from '../model'
import type { VersionsActions, VersionsModel } from '../screen'
import { VersionsCard } from './VersionsCard'
import '../../../styles.css'
import '../cost-sheets.css'

/** The Cost tab's W2b parts (B-W2b-430); each is drawn when given (a design case draws one). */
export interface CostSheetsModel {
  readonly steps?: CostStepsModel
  readonly versions?: VersionsModel
  readonly goal?: TargetPriceModel
  readonly bySize?: BySizeModel
}

export interface CostSheetsActions {
  readonly steps?: CostStepsActions
  readonly versions?: VersionsActions
  readonly goal?: TargetPriceActions
  readonly bySize?: BySizeActions
}

/** The catalogues these parts read (WithMessages replaces the page's: the products words come along for units and kinds). */
export const COST_SHEETS_NAMESPACES = [CS_NS, 'products'] as const

/**
 * Style › Cost, the cost sheets of W2b (B-W2b-430), after W1's sheet in the tab's section list: the sheet's W2b steps
 * (subcontract, packaging, freight and duties, commissions; SCR-502), the versions and their approval (SCR-500, compare
 * SCR-501), the target price of the version in view (SCR-503) and its cost by size with the suggested surcharges (SCR-504).
 * One view model; the container (CostSheets.tsx) reads and writes.
 */
export function CostSheetsView({ model, actions }: { model: CostSheetsModel; actions?: CostSheetsActions }) {
  return (
    <WithMessages namespaces={[...COST_SHEETS_NAMESPACES]}>
      <div className="fw-st-stack-lg fw-cs">
        {model.steps && <CostStepsCard model={model.steps} actions={actions?.steps} />}
        {model.versions && <VersionsCard model={model.versions} actions={actions?.versions} />}
        {(model.goal || model.bySize) && (
          <div className="fw-cs-pair">
            {model.goal && <TargetPriceCard key={model.goal.sheet?.id ?? 'none'} model={model.goal} actions={actions?.goal} />}
            {model.bySize && <BySizeCard model={model.bySize} actions={actions?.bySize} />}
          </div>
        )}
      </div>
    </WithMessages>
  )
}

'use client'

import { Card, SummaryTable } from '@nexus/ui/components'
import { useLocale } from '../../../../../lib/i18n/provider'
import { unitPrice } from '../../../quotes/model'
import { useFollowupsT } from '../words'
import { CostChangedMark } from './CostChangedMark'

export interface CostChangedDesignModel {
  currency: string
  lines: { id: string; label: string; pieces: number; cost: string; change: number | null }[]
}

/** SCR-530's frame: made-up lines with their kept cost and the mark beside it (the screens that use it have their own cases). */
export function CostChangedDesign({ model }: { model: CostChangedDesignModel }) {
  const t = useFollowupsT()
  const locale = useLocale()
  return (
    <Card padded header={t('design.title')} description={t('design.sub')}>
      <SummaryTable
        label={t('design.title')}
        columns={[t('design.col.line'), t('design.col.pieces'), t('design.col.cost')]}
        align={[undefined, 'right', 'right']}
        rows={model.lines.map((line) => ({
          id: line.id,
          cells: [
            line.label,
            String(line.pieces),
            <span key="cost" className="fw-cc-cost">
              <span>{unitPrice(line.cost, model.currency, locale)}</span>
              <CostChangedMark change={line.change} currency={model.currency} />
            </span>,
          ],
        }))}
        stackOnPhone
      />
    </Card>
  )
}

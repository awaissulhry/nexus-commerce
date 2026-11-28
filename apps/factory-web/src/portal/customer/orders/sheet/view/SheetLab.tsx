'use client'

import type { OwnColumn, OwnValue } from '../../../../../lib/order-lines/schema'
import { OwnChips } from '../../../../../lib/order-lines/own-columns/OwnChips'
import { StateChip } from '../../../../../lib/order-cells/view/StateChip'
import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import type { WaitChip } from '../model'
import { useT } from '../../../../../lib/i18n/provider'
import { DraftsBar, PictureButton, SentLine, SHEET_NS, WaitsChips, WithdrawnChip, type DraftsBarModel, type SentLineModel } from './SheetParts'

/**
 * owb-po7.4 — the design index's lab of the orders sheet's own parts (the gallery pattern of `view/CustomerCase.tsx`): the drafts bar,
 * the line after Send, the Withdrawn chip, and a few rows with their picture button, life word, Waits · news and Details. Draws only
 * what it is given (made-up data in `../fixtures.ts`).
 */
export interface SheetLabModel {
  readonly drafts: DraftsBarModel
  readonly sent: SentLineModel | null
  readonly withdrawn: { readonly count: number; readonly shown: boolean }
  readonly columns: readonly OwnColumn[]
  readonly rows: readonly {
    readonly id: string
    readonly title: string
    readonly life: OrderLife
    readonly waits: readonly WaitChip[]
    readonly lines: readonly Readonly<Record<string, OwnValue['value']>>[]
    readonly picture: boolean
  }[]
}

export function SheetLab({ model }: { model: SheetLabModel }) {
  const t = useT(SHEET_NS)
  return (
    <div className="fw-pos-top">
      {model.sent ? <SentLine model={model.sent} /> : null}
      <DraftsBar model={model.drafts} />
      <span className="fw-pos-bar">
        <WithdrawnChip count={model.withdrawn.count} shown={model.withdrawn.shown} />
      </span>
      <ul className="fw-pos-top">
        {model.rows.map((row) => (
          <li key={row.id} className="fw-pos-bar">
            {row.picture ? <PictureButton picture={<span className="fw-pos-quiet">{row.title.slice(0, 2)}</span>} label={t('ordersSheet.picture')} onPress={() => undefined} /> : null}
            <strong>{row.title}</strong>
            <StateChip life={row.life} />
            <WaitsChips chips={row.waits} />
            <OwnChips columns={model.columns} lines={row.lines} />
          </li>
        ))}
      </ul>
    </div>
  )
}

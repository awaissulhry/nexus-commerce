'use client'

import { ArrowUpToLine } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, OrderedList } from '../../../../lib/i18n/ds-parts'
import type { ProductionRow } from '../api'
import { rowName, stylesText } from '../model'
import { useProductionPageWords } from '../words'
import '../production.css'

export interface UrgentOrderDialogModel {
  /** The urgent orders' ids in the order shown (Urgent 1 first). Only urgent orders move here. */
  items: readonly string[]
  /** Why "Save order" cannot send now (nothing moved, saving, offline, a preview), else null. */
  held: string | null
  busy: boolean
  /** A refusal in words; `conflict`: the list changed since it was read ("Changed by us at 10:42") — use the new list or keep mine. */
  problem: { words: string; conflict: boolean } | null
}

export interface UrgentOrderDialogActions {
  onChange?: (items: string[]) => void
  onTop?: (id: string) => void
  onSave?: () => void
  onClose?: () => void
  onLoadTheirs?: () => void
  onKeepMine?: () => void
}

/**
 * F-PR-11 — "Urgent order" (17-web-r2 §1.4; DS gap G-R2-1: no row drag in a list, so the drag lives here): the customer's urgent
 * orders in its own order, a DS OrderedList with the live drag, the keyboard grip (↑ ↓, the place spoken) and a "Move to top"
 * button per row; a DS Modal, a sheet on a phone. "Your urgent orders go first among your orders when we next plan. Dates change
 * only when we tell you." Save sends the whole list with the time it was read; a change since reads "Changed by us at 10:42"
 * (never a name) with "Use the new list" / "Keep my order".
 */
export function UrgentOrderDialog({ model, rows, actions }: { model: UrgentOrderDialogModel; rows: readonly ProductionRow[]; actions?: UrgentOrderDialogActions }) {
  const { t, locale } = useProductionPageWords()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const nameOf = (id: string) => {
    const row = byId.get(id)
    return row ? rowName(row, locale, t) : t('row.noName')
  }
  const footer = (
    <>
      <Button variant="secondary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onClose?.()}>
        {t('dialog.cancel')}
      </Button>
      <Button variant="primary" heldReason={model.held} onClick={() => actions?.onSave?.()}>
        {model.busy ? t('dialog.saving') : t('dialog.save')}
      </Button>
    </>
  )
  return (
    <Modal open sheet size="md" onClose={() => actions?.onClose?.()} title={t('dialog.title')} subtitle={t('dialog.how')} footer={footer} closeHeld={model.busy ? t('held.busy') : null}>
      <div className="fw-pprod-dialog">
        {model.problem ? (
          <Banner
            tone="warning"
            title={model.problem.words}
            action={
              model.problem.conflict ? (
                <span className="fw-pprod-actions">
                  <Button size="sm" onClick={() => actions?.onLoadTheirs?.()}>
                    {t('dialog.loadTheirs')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onKeepMine?.()}>
                    {t('dialog.keepMine')}
                  </Button>
                </span>
              ) : undefined
            }
          />
        ) : null}
        <OrderedList
          label={t('dialog.list')}
          items={model.items}
          onChange={(items) => actions?.onChange?.(items)}
          itemLabel={nameOf}
          keyboardGrip
          liveDrag
          disabled={model.busy}
          renderItem={(id) => {
            const index = model.items.indexOf(id)
            const row = byId.get(id)
            return (
              <span className="fw-pprod-item">
                <span className="fw-pprod-item-rank" aria-hidden>
                  {index + 1}
                </span>
                <span className="fw-pprod-item-name">
                  <strong className="fw-pprod-clip">{nameOf(id)}</strong>
                  {row ? <span className="fw-pprod-sub fw-pprod-clip">{stylesText(row, t)}</span> : null}
                </span>
                {index > 0 ? (
                  <Button size="sm" variant="quiet" aria-label={t('dialog.topLabel', { name: nameOf(id) })} heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onTop?.(id)}>
                    <ArrowUpToLine size={14} aria-hidden /> {t('dialog.top')}
                  </Button>
                ) : null}
              </span>
            )
          }}
        />
        <p className="fw-pprod-hint">{t('dialog.promise')}</p>
      </div>
    </Modal>
  )
}

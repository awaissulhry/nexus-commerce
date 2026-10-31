'use client'

import { CheckCircle2, CircleAlert, Printer } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { ShipmentRow } from '../../api'
import { printDdtsHeld, printDdtsPlan } from '../../daily-model'
import type { ShippingAbilities } from '../../model'
import type { PrintDdtsModel, ShipmentsListActions } from '../list-model'

const OUTCOME_TONE = { queued: 'success', refused: 'danger', skipped: 'neutral' } as const

/**
 * Print N DDTs (design warehouse.shipments sh-grid, selection row "Print 4 DDTs", W2a): the live DDT of each selected
 * shipment on its site's document printer (Carriers & shipping), one print job per DDT; a shipment without a live DDT is
 * skipped and named. Then each shipment's outcome in words: queued, or why not (its site has no document printer, the
 * DDT's PDF is not stored yet…). Esc closes; ⌘↵ prints.
 */
export function PrintDdtsDialog({ model, rows, can, actions }: { model: PrintDdtsModel; rows: readonly ShipmentRow[]; can: ShippingAbilities; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const picked = rows.filter((row) => model.ids.includes(row.id))
  const plan = printDdtsPlan(picked)
  const blocked = printDdtsHeld(plan, can)
  const held = model.busy ? t('held.busy') : blocked ? t(blocked.key, blocked.params) : null
  const done = model.outcomes
  const queued = done?.filter((entry) => entry.state === 'queued').length ?? 0
  return (
    <Modal
      open
      onClose={() => actions?.onPrintDdtsClose?.()}
      title={t('printDdts.title', { count: plan.printable.length })}
      subtitle={t('printDdts.subtitle', { count: picked.length })}
      size="md"
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onPrintDdtsClose?.()}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onPrintDdtsClose?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPrintDdtsGo?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
              <Printer size={14} aria-hidden /> {t('printDdts.go', { count: plan.printable.length })}
            </Button>
          </>
        )
      }
    >
      <div
        className="fw-sh-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !done) {
            event.preventDefault()
            actions?.onPrintDdtsGo?.()
          }
        }}
      >
        {done ? (
          <>
            <p className="fw-sh-done">
              {queued === done.filter((entry) => entry.state !== 'skipped').length ? <CheckCircle2 size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />} {t('printDdts.done', { count: queued })}
            </p>
            <ul className="fw-sh-outcomes">
              {done.map((entry) => (
                <li key={entry.id} className="fw-sh-outcome">
                  <Pill tone={OUTCOME_TONE[entry.state]}>{t(`printDdts.state.${entry.state}`)}</Pill>
                  <span>
                    {entry.number}
                    {entry.ddt ? ` · ${t('printDdts.ddt', { number: entry.ddt })}` : ''} — {t(entry.words.key, entry.words.params)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p>{t('printDdts.what')}</p>
            <ul className="fw-sh-list">
              {plan.printable.map((row) => (
                <li key={row.id}>
                  {row.number} · {t('printDdts.ddt', { number: row.ddt!.number })} · {row.partyName}
                </li>
              ))}
            </ul>
            {plan.skipped.length > 0 && <p className="fw-sh-hint">{t('printDdts.skipped', { count: plan.skipped.length, numbers: plan.skipped.map((row) => row.number).join(', ') })}</p>}
            <p className="fw-sh-hint">{t('printDdts.printer')}</p>
            {model.busy && (
              <p className="fw-sh-hint" role="status">
                <Spinner size={14} /> {t('printDdts.busy')}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

'use client'

import { Banner } from '@nexus/ui/components'
import { Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import type { CompanyTerms } from '../api'
import { poChanges, poHeld, poRows, valueOf, type DepthCan, type Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

/**
 * Tax & terms › Commercial terms › Customer PO number required (B-W2b-324; SAL-013; design customer.tax.terms#1): per
 * company the reader sees the customer in, a switch — on, an order of the customer with that company is refused when it is
 * made without the customer's PO number. Saved explicitly (EditModeBar, ⌘S) through the company's terms (B-W2b-290: the
 * row is made when the company has none). Fetches nothing.
 */

export interface PoNumberModel {
  readonly read: Read<CompanyTerms>
  readonly can: DepthCan
  readonly status: string
  readonly draft: Readonly<Record<string, boolean>>
  readonly saving: boolean
  readonly failed: string | null
}

export interface PoNumberActions {
  onToggle?: (companyId: string, on: boolean) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
}

export function PoNumberCard({ model, actions }: { model: PoNumberModel; actions?: PoNumberActions }) {
  const { t, when } = useSay()
  const read = valueOf(model.read)
  const rows = read ? poRows(read) : []
  const changes = poChanges(rows, model.draft)
  return (
    <DepthCard title={t('po.title')} hint={t('po.hint')}>
      <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('po.title')} onRetry={actions?.onRetry} rows={2}>
        <ul className="fw-cdp-list">
          {rows.map((row) => {
            const held = poHeld(row, model.can, model.status)
            const on = model.draft[row.companyId] ?? row.required
            return (
              <li key={row.companyId} className="fw-cdp-toggle-row">
                <Toggle checked={on} onChange={(next) => actions?.onToggle?.(row.companyId, next)} disabled={held !== null || model.saving} aria-label={t('po.toggle', { company: row.name })} />
                <span className="fw-cdp-cell">
                  <span className="fw-cdp-name">{t(on ? 'po.required' : 'po.notRequired', { company: row.name })}</span>
                  <span className="fw-cdp-hint">{row.own && row.setAt ? t('po.setBy', { by: row.setBy ?? t('hold.system'), date: when(row.setAt) }) : t('po.partyOwn')}</span>
                  {held ? <span className="fw-cdp-hint">{t(held)}</span> : null}
                </span>
              </li>
            )
          })}
        </ul>
        {model.failed ? <Banner tone="danger" title={t(model.failed)} /> : null}
        {changes.length > 0 && (
          <div className="fw-cdp-bar">
            <EditModeBar
              message={t('po.unsaved', { count: changes.length })}
              count={changes.length}
              onDiscard={() => actions?.onDiscard?.()}
              onApply={() => actions?.onSave?.()}
              applyLabel={t('po.save')}
              busy={model.saving}
              saveShortcut
            />
          </div>
        )}
      </ReadOr>
    </DepthCard>
  )
}

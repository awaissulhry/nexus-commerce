'use client'

import { Package, RotateCcw } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, InfoTip, Select } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { useT } from '../../../../lib/i18n/provider'
import type { BoardCard, BoardFilters } from '../api'
import { BASKETS_NAMESPACE, type BoardColumn, type FilterOption } from '../model'
import { BasketCard } from './BasketCard'
import '../baskets.css'

/**
 * owb-fl9 step 1 — Production › Baskets board (design § 2, § 6; P/office.js page `board`): the filters (team · department · order),
 * then one column per department in use and one for Ready to ship. The columns share the page's width (no dead space at 1440 or
 * 1920; many departments scroll inside the board, never the page); on a narrow window (a phone) the board is ONE column list, by the
 * board's own width. Keys: one ⓘ. The view fetches nothing (BasketsBoardPage.tsx reads).
 */

export type FilterKey = keyof BoardFilters

export interface BoardModel {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly columns: readonly BoardColumn[]
  readonly filters: BoardFilters
  readonly options: { readonly teams: readonly FilterOption[]; readonly departments: readonly FilterOption[]; readonly orders: readonly FilterOption[] }
  /** The problem's words key when the read failed. */
  readonly problem: string | null
}

export interface BoardActions {
  readonly onFilter: (key: FilterKey, value: string | null) => void
  readonly onOpen: (card: BoardCard) => void
  readonly onRetry: () => void
}

function FilterSelect({ id, label, all, value, options, onChange }: { id: string; label: string; all: string; value: string | null | undefined; options: readonly FilterOption[]; onChange: (value: string | null) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

export function BoardView({ model, actions }: { model: BoardModel; actions: BoardActions }) {
  const t = useT(BASKETS_NAMESPACE)
  const total = model.columns.reduce((sum, column) => sum + column.cards.length, 0)
  return (
    <div className="fw-bb-page">
      <div className="fw-bb-bar">
        <FilterSelect id="fw-bb-team" label={t('filter.team')} all={t('filter.allTeams')} value={model.filters.teamId} options={model.options.teams} onChange={(value) => actions.onFilter('teamId', value)} />
        <FilterSelect id="fw-bb-dept" label={t('filter.department')} all={t('filter.allDepartments')} value={model.filters.departmentId} options={model.options.departments} onChange={(value) => actions.onFilter('departmentId', value)} />
        <FilterSelect id="fw-bb-order" label={t('filter.order')} all={t('filter.allOrders')} value={model.filters.salesOrderId} options={model.options.orders} onChange={(value) => actions.onFilter('salesOrderId', value)} />
        <span className="fw-bb-count">{t('board.count', { count: total })}</span>
        <InfoTip tip={t('board.keys')} />
      </div>

      {model.state === 'failed' ? (
        <Banner tone="danger" title={t(model.problem ?? 'error.read')} action={<Button size="sm" onClick={actions.onRetry}><RotateCcw aria-hidden /> {t('board.retry')}</Button>} />
      ) : null}

      {model.state === 'loading' ? <p className="fw-bb-muted">{t('board.loading')}</p> : null}

      {model.state === 'ready' && total === 0 ? (
        <EmptyState icon={<Package aria-hidden />} title={t('board.empty')} description={t('board.emptyHint')} />
      ) : null}

      {model.state === 'ready' && total > 0 ? (
        <div className="fw-bb-board" role="list" aria-label={t('board.label')}>
          {model.columns.map((column) => (
            <section key={column.key} className="fw-bb-col" role="listitem" aria-label={column.department ? `${column.department.no} ${column.department.shortName}` : t('column.ready')}>
              <header className="fw-bb-colhead">
                {column.department ? (
                  <DeptChip dept={column.department} />
                ) : (
                  <span className="fw-bb-ready">
                    <Package aria-hidden /> {t('column.ready')}
                  </span>
                )}
                <span className="fw-bb-n">{column.cards.length}</span>
              </header>
              <div className="fw-bb-cards">
                {column.cards.length === 0 ? <p className="fw-bb-none">{t('column.none')}</p> : column.cards.map((card) => <BasketCard key={card.bundleId} card={card} ready={column.department === null} onOpen={actions.onOpen} />)}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}

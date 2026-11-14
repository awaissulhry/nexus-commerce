'use client'

import { useMemo, useRef, type KeyboardEvent } from 'react'
import { Banner } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { MINIMUM_ACTIONS, MINIMUM_PER } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useFollowupsT } from '../../../_shared/cost-changed/words'
import { percent, unitPrice } from '../../../quotes/model'
import type { Minimum } from '../../depth/api'
import type { Phrase, PriceListAbilities } from '../../model'
import { minimumEditHeld, surchargeHeld, surchargeTyped, type MinimumEditState, type MinimumField } from '../model'

export interface MinimumColumnsInput {
  /** The Breaks & surcharges tab's own words (`sales-prices-depth`): the column heads, the subjects, the actions. */
  depth: (key: string, params?: Record<string, string | number>) => string
  currency: string
  can: Pick<PriceListAbilities, 'manage' | 'price'>
  listArchived: boolean
  edit: MinimumEditState
  onCell?: ((row: Minimum, field: MinimumField, text: string) => void) | undefined
}

/**
 * The Minimums list frame's columns with their cells edited in place (B-W2b-380, XF6:03): Applies to and Status read; the
 * minimum, per, below it, the small-run surcharge and the note typed or picked in their cells, each saved alone (its mark:
 * saving, or not saved). A cell that cannot change says why (its title and its label); an archived minimum is read only.
 */
export function useMinimumColumns(input: MinimumColumnsInput): ColDef<Minimum>[] {
  const t = useFollowupsT()
  const locale = useLocale()
  const latest = useRef(input)
  latest.current = input
  const { depth, currency, can, listArchived } = input
  return useMemo<ColDef<Minimum>[]>(() => {
    const say = (phrase: Phrase) => t(phrase.key, phrase.params)
    // The subject in words (a style's or a material's code, a kind of garment's name): the cells' labels name it.
    const subjectOf = (row: Minimum) => row.style?.code ?? row.item?.code ?? depth(`minimums.type.${row.productType ?? 'OTHER'}`)
    const keys = (event: KeyboardEvent<HTMLInputElement>, value: string) => {
      event.stopPropagation()
      if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      if (event.key === 'Escape') {
        ;(event.target as HTMLInputElement).value = value
        ;(event.target as HTMLInputElement).blur()
      }
    }
    const mark = (row: Minimum, field: MinimumField) => {
      const state = latest.current.edit.cells[`${row.id}:${field}`]
      return state ? <span className={`fw-pld-mark ${state}`}>{t(`minimums.cell.${state}`)}</span> : null
    }
    const Typed = (field: 'minQuantity' | 'note' | 'surcharge') =>
      function Cell({ data }: ICellRendererParams<Minimum>) {
        if (!data) return null
        const held = field === 'surcharge' ? surchargeHeld(data, can, listArchived) : minimumEditHeld(data, can, listArchived)
        const value = field === 'minQuantity' ? String(data.minQuantity) : field === 'note' ? (data.note ?? '') : surchargeTyped(data)
        if (held) {
          const shown = field === 'minQuantity' ? depth(`minimums.per.${data.per}`, { count: data.minQuantity }) : field === 'note' ? (data.note ?? '—') : data.action !== 'SURCHARGE' ? '—' : !can.price ? t('minimums.noPrice') : data.surchargeAmount ? unitPrice(data.surchargeAmount, data.currency ?? currency, locale) : data.surchargePct ? percent(data.surchargePct, locale) : '—'
          return (
            <span className="fw-pld-cell" title={say(held)}>
              <span>{shown}</span>
            </span>
          )
        }
        return (
          <span className="fw-pld-edit">
            <Input
              key={`${data.id}-${field}-${data.version}`}
              size="sm"
              fieldClassName="fw-pld-edit-input"
              inputMode={field === 'note' ? 'text' : field === 'minQuantity' ? 'numeric' : 'decimal'}
              aria-label={t(`minimums.edit.${field}`, { subject: subjectOf(data) })}
              placeholder={field === 'surcharge' ? t('minimums.surchargeHint', { currency }) : undefined}
              defaultValue={value}
              maxLength={field === 'note' ? 500 : 24}
              onKeyDown={(event) => keys(event, value)}
              onBlur={(event) => {
                const next = event.target.value.trim()
                if (next !== value) latest.current.onCell?.(data, field, next)
              }}
            />
            {mark(data, field)}
          </span>
        )
      }
    const Picked = (field: 'per' | 'action') =>
      function Cell({ data }: ICellRendererParams<Minimum>) {
        if (!data) return null
        const held = minimumEditHeld(data, can, listArchived)
        if (held) {
          return field === 'action' ? (
            <span title={say(held)}>
              <Tag tone={data.action === 'BLOCK' ? 'danger' : data.action === 'WARN' ? 'warning' : 'info'}>{depth(`minimums.action.${data.action}`)}</Tag>
            </span>
          ) : (
            <span title={say(held)}>{t(`minimums.per.${data.per}`)}</span>
          )
        }
        const options = field === 'per' ? MINIMUM_PER : MINIMUM_ACTIONS
        return (
          <span className="fw-pld-edit">
            <Select
              size="sm"
              value={field === 'per' ? data.per : data.action}
              aria-label={t(`minimums.edit.${field}`, { subject: subjectOf(data) })}
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(event) => latest.current.onCell?.(data, field, event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {field === 'per' ? t(`minimums.per.${option}`) : depth(`minimums.action.${option}`)}
                </option>
              ))}
            </Select>
            {mark(data, field)}
          </span>
        )
      }
    const SubjectCell = ({ data }: ICellRendererParams<Minimum>) =>
      data ? (
        <span className="fw-pld-cell">
          <strong>{data.subject === 'STYLE' ? (data.style ? `${data.style.code} · ${data.style.name}` : '—') : data.subject === 'PRODUCT_TYPE' ? depth(`minimums.type.${data.productType ?? 'OTHER'}`) : data.item ? `${data.item.code} · ${data.item.name}` : '—'}</strong>
          <span className="fw-pld-sub">{depth(`minimums.subject.${data.subject}`)}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Minimum>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{depth(`minimums.status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'subject', headerName: depth('minimums.col.subject'), minWidth: 220, flex: 1.6, cellRenderer: SubjectCell, valueGetter: (params) => params.data?.style?.code ?? params.data?.productType ?? params.data?.item?.code ?? '' },
      { colId: 'minimum', headerName: depth('minimums.col.minimum'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: Typed('minQuantity'), valueGetter: (params) => params.data?.minQuantity ?? 0 },
      { colId: 'per', headerName: t('minimums.col.per'), minWidth: 150, flex: 0.8, cellRenderer: Picked('per'), valueGetter: (params) => params.data?.per ?? '' },
      { colId: 'action', headerName: depth('minimums.col.action'), minWidth: 250, flex: 1.3, cellRenderer: Picked('action'), valueGetter: (params) => params.data?.action ?? '' },
      { colId: 'surcharge', headerName: t('minimums.col.surcharge'), minWidth: 200, flex: 0.9, type: 'rightAligned', cellRenderer: Typed('surcharge'), valueGetter: (params) => (params.data ? surchargeTyped(params.data) : '') },
      { colId: 'note', headerName: depth('minimums.col.note'), minWidth: 180, flex: 1.1, cellRenderer: Typed('note'), valueGetter: (params) => params.data?.note ?? '' },
      { colId: 'status', headerName: depth('minimums.col.status'), minWidth: 120, flex: 0.6, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
    ]
    // Words, grains and the language rebuild the cells; the edit state and the actions are read through `latest`.
  }, [t, depth, locale, currency, can, listArchived, input.edit.cells])
}

/** The last word about the minimums' in-place edits (saved, refused with why), above their list frame. */
export function MinimumsNotice({ edit, onDismiss }: { edit: MinimumEditState; onDismiss?: (() => void) | undefined }) {
  const t = useFollowupsT()
  if (!edit.notice) return null
  return (
    <Banner
      tone={edit.notice.tone}
      title={t(edit.notice.words.key, edit.notice.words.params)}
      action={
        <Button size="sm" variant="quiet" onClick={() => onDismiss?.()}>
          {t('minimums.dismiss')}
        </Button>
      }
    />
  )
}

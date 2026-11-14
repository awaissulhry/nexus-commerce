'use client'

import { Banner } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import Link from 'next/link'
import { Listbox, Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import '../../dashboards.css'
import type { BoardEntry, DashboardKey } from '../../api'

/**
 * "Save as dashboard" (follow-up DB1:01: "the report panels of W2b-5 are pinnable to a dashboard, saved per person on the server,
 * not per device"; design sales.reports band ⋯): which dashboard (my role's first) and which of this report page's panels; Pin
 * adds them to my arrangement of that dashboard (PUT /insights/dashboards/:board/layout), shown at the end, half width. The
 * result says where they went (a link to the dashboard) or why not. One view model, nothing fetched.
 */

export interface PinModel {
  readonly open: boolean
  readonly area: string
  /** The page's pinnable panels (`report:<area>.<panel>`). */
  readonly panels: readonly string[]
  readonly boards: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: readonly BoardEntry[] }
  readonly board: DashboardKey | null
  readonly chosen: readonly string[]
  readonly busy: boolean
  /** Pinned: the dashboard's address (company-prefixed). */
  readonly done: string | null
  readonly problem: string | null
}

export interface PinActions {
  onBoard?: (board: DashboardKey) => void
  onChosen?: (ids: string[]) => void
  onPin?: () => void
  onClose?: () => void
}

export function PinDialog({ model, actions }: { model: PinModel; actions?: PinActions }) {
  if (!model.open) return null
  return (
    <WithMessages namespaces={['home-dashboards']}>
      <Pin model={model} actions={actions} />
    </WithMessages>
  )
}

function Pin({ model, actions }: { model: PinModel; actions?: PinActions | undefined }) {
  const t = useT('home-dashboards')
  const panelOf = (id: string) => id.slice(`report:${model.area}.`.length)
  const held = model.busy ? t('pin.busy') : model.boards.status !== 'ready' ? t('pin.noBoards') : model.board === null ? t('pin.chooseBoard') : model.chosen.length === 0 ? t('pin.choosePanel') : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('pin.title')}
      size="sm"
      footer={
        <>
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {model.done ? t('pin.close') : t('pin.cancel')}
          </Button>
          {model.done ? null : (
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPin?.()}>
              {t('pin.confirm', { count: model.chosen.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-dash-pin">
        <p className="fw-dash-muted">{t('pin.intro', { area: t(`pinned.area.${model.area}`) })}</p>
        {model.boards.status === 'error' ? <Banner tone="danger" title={t('pin.boardsFailed')}>{t(model.boards.problem)}</Banner> : null}
        {model.boards.status === 'ready' ? (
          <Listbox
            ariaLabel={t('pin.board')}
            width="100%"
            value={model.board ?? ''}
            placeholder={t('pin.chooseBoard')}
            onChange={(next) => actions?.onBoard?.(next as DashboardKey)}
            options={model.boards.value.map((entry) => ({ value: entry.key, label: t(`board.${entry.key}`), ...(entry.mine ? { trailing: t('band.mine') } : {}) }))}
          />
        ) : null}
        <fieldset className="fw-dash-widths">
          <legend className="fw-dash-widths-legend">{t('pin.panels')}</legend>
          {model.panels.map((id) => (
            <Checkbox
              key={id}
              label={t(`pinned.${model.area}.${panelOf(id)}`)}
              checked={model.chosen.includes(id)}
              onChange={(event) => actions?.onChosen?.(event.target.checked ? [...model.chosen, id] : model.chosen.filter((entry) => entry !== id))}
            />
          ))}
        </fieldset>
        <p className="fw-dash-muted">{t('arrange.server')}</p>
        {model.done ? (
          <Banner tone="success" title={t('pin.done', { count: model.chosen.length })}>
            <Link className="fw-dash-link" href={model.done}>
              {t('pin.openDashboard', { board: model.board ? t(`board.${model.board}`) : '' })}
            </Link>
          </Banner>
        ) : null}
        {model.problem ? <Banner tone="danger" title={t('pin.refused')}>{t(model.problem)}</Banner> : null}
      </div>
    </Modal>
  )
}

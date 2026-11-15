'use client'

import { Pin, PinOff } from 'lucide-react'
import { Banner, EmptyState, SavedChip } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { AsOf } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { MyViewsModel, ViewChip } from '../model'
import '../../today.css'
import '../my-views.css'

export interface MyViewsActions {
  /** A chip was chosen: its list with the view. */
  onOpen?: (chip: ViewChip) => void
  onUnpin?: (chip: ViewChip) => void
  onRetry?: () => void
}

/**
 * Today › My saved views (design home.today `my-views`, W2b; PLT-163): my pinned views as chips, "name · count", each opening
 * its list with the view; the count is the one counted for me last (AsOf beside it), "—" until it is counted, "1000+" when the
 * view holds more than are counted. Unpin on the chip. Empty: how to pin one. It draws ONE model.
 */
export function MyViewsView({ model, actions }: { model: MyViewsModel; actions?: MyViewsActions }) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <MyViews model={model} actions={actions} />
    </WithMessages>
  )
}

function MyViews({ model, actions }: { model: MyViewsModel; actions?: MyViewsActions }) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const held = model.held ? t(model.held) : null
  const state = model.views
  const newest = state.status === 'ready' ? state.data.map((chip) => chip.countedAt).filter((at): at is string => at !== null).sort().at(-1) ?? null : null
  return (
    <section className="fw-today-section" aria-labelledby="fw-mywork-views">
      <div className="fw-today-head">
        <h2 id="fw-mywork-views" className="fw-today-h">
          {t('views.title')}
        </h2>
        {newest && <AsOf at={newest} now={model.now} />}
      </div>
      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} />}
      {state.status === 'loading' ? (
        <div className="fw-mywork-views" aria-busy="true">
          <p className="fw-today-muted" role="status">
            {t('loading')}
          </p>
          <Skeleton height={28} width={160} />
          <Skeleton height={28} width={140} />
        </div>
      ) : state.status === 'error' ? (
        <Banner tone="danger" title={t('views.error')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>}>
          {t(state.problem)}
        </Banner>
      ) : state.data.length === 0 ? (
        <EmptyState icon={<Pin size={22} aria-hidden />} title={t('views.empty.title')} description={t('views.empty.body')} />
      ) : (
        <ul className="fw-mywork-views" aria-label={t('views.title')}>
          {state.data.map((chip) => {
            const count = chip.count ? t(chip.count.key, { count: formatNumber(chip.count.count, locale) }) : '—'
            return (
              <li key={chip.viewId}>
                <SavedChip
                  label={chip.name}
                  meta={count}
                  title={chip.href ? (chip.count ? t('views.open', { name: chip.name, count }) : t('views.notCounted', { name: chip.name })) : t('views.notBuilt', { name: chip.name })}
                  onSelect={() => chip.href && actions?.onOpen?.(chip)}
                  actions={[{ label: held ?? t('views.unpin', { name: chip.name }), icon: <PinOff size={13} aria-hidden />, disabled: held !== null, onClick: () => actions?.onUnpin?.(chip) }]}
                />
                {!chip.href && <Tag tone="neutral">{t('views.notBuiltShort')}</Tag>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

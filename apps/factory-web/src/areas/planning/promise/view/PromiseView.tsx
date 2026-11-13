'use client'

import { useMemo } from 'react'
import { Calculator, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { Button, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { NAMESPACE, OWN_KEYS, TILE_ORDER, type Words } from '../model'
import type { PromiseActions, PromiseModel } from '../view-model'
import { AtpSection } from './AtpSection'
import { CalculatorModal } from './CalculatorModal'
import { LinesSection } from './LinesSection'
import { RepromiseModal } from './RepromiseModal'
import '../promise.css'

export type { PromiseActions, PromiseModel } from '../view-model'

/**
 * SCR-109 — Planning › Dates › Promise dates (design planning.promise, a workspace list). The band: as of, live, the site,
 * the Promise calculator (primary), ⋯ (Export the lines, Keyboard shortcuts). Then three sections, each loading and failing
 * on its own: Promises (the saved-filter tiles: At risk, Slipped this month, Re-promise waiting for sales, No valid
 * certificate through ship date — a tile narrows the lines), Open order lines (every promise with the planned finish next
 * to it; Re-promise is the row verb, `p` on the focused line; the Changes cell opens the history; the order opens in its
 * record, ⌘-click a new tab), Available to promise (for stock styles: what can still be promised per size, colour and week).
 * The Re-promise modal (the planner's proposal, or sales' word on one that waits) and the Promise calculator. No page
 * max-width; no money; no person in a list.
 */
export function PromiseView({ model, actions }: { model: PromiseModel; actions?: PromiseActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <PromiseScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function PromiseScreen({ model, actions }: { model: PromiseModel; actions?: PromiseActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, locale }), [t, locale])

  if (!model.can.view) {
    return (
      <div className="fw-pdt">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const list = model.list.status === 'ready' ? model.list.value : null
  const calcHeld = !model.siteId ? t('held.noSite') : null

  return (
    <div className="fw-pdt">
      <div className="fw-pdt-head">
        <span className="fw-pdt-status" role="status">
          {model.list.status === 'loading' ? <Skeleton width={180} height={18} /> : list ? t('page.asOf', { time: formatDateTime(list.asOf, { locale }) }) : null}
          <span>{t(`live.${model.live}`)}</span>
        </span>
        <span className="fw-pdt-inline">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-pdt-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <Button size="sm" variant="primary" heldReason={calcHeld} onClick={() => actions?.onCalculator?.(true)}>
            <Calculator size={14} aria-hidden /> {t('page.calculator')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.([]), disabled: !list || list.lines.length === 0 },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {model.sites.status === 'error' && (
        <Banner
          tone="danger"
          title={t('page.sitesFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.sites.problem)}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section aria-labelledby="fw-pdt-tiles" className="fw-pdt-section">
        <div className="fw-pdt-section-head">
          <h2 className="fw-pdt-h2" id="fw-pdt-tiles">
            {t('tiles.title')}
          </h2>
          <p className="fw-pdt-hint">{t('tiles.purpose')}</p>
        </div>
        {model.list.status === 'error' ? (
          <Card padded>
            <EmptyState
              title={t('tiles.error')}
              description={t(model.list.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
                  {t('common.retry')}
                </Button>
              }
            />
          </Card>
        ) : (
          <MetricStrip
            metrics={TILE_ORDER.map((tile) => {
              const value = list ? String(list.tiles[tile]) : '—'
              const hint = list ? t(`tiles.hint.${tile}`) : t('tiles.loading')
              return list
                ? { label: t(`tile.${tile}`), value, hint, onClick: () => actions?.onTile?.(model.controls.tile === tile ? null : tile), active: model.controls.tile === tile }
                : { label: t(`tile.${tile}`), value, hint }
            })}
          />
        )}
      </section>

      <section aria-labelledby="fw-pdt-lines" className="fw-pdt-section">
        <div className="fw-pdt-section-head">
          <h2 className="fw-pdt-h2" id="fw-pdt-lines">
            {t('lines.title')}
          </h2>
          <p className="fw-pdt-hint">{t('lines.purpose')}</p>
        </div>
        {list && !list.complete && <Banner tone="info" title={t('lines.incomplete', { count: list.lines.length })} />}
        <LinesSection model={model} actions={actions} words={words} />
      </section>

      <section aria-labelledby="fw-pdt-atp" className="fw-pdt-section">
        <div className="fw-pdt-section-head">
          <h2 className="fw-pdt-h2" id="fw-pdt-atp">
            {t('atp.title')}
          </h2>
          <p className="fw-pdt-hint">{t('atp.purpose')}</p>
        </div>
        <AtpSection model={model} actions={actions} words={words} />
      </section>

      {model.repromise && <RepromiseModal model={model} actions={actions} words={words} />}
      {model.calculator && <CalculatorModal model={model} actions={actions} words={words} />}
      {model.dialog?.kind === 'keys' && (
        <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('page.keys')} size="sm">
          <KeysList t={t} />
        </Modal>
      )}
    </div>
  )
}

function KeysList({ t }: { t: (key: string) => string }) {
  const lists = useT('lists')
  return (
    <ul className="fw-pdt-list">
      {listKeys(OWN_KEYS(t), true).map((entry) => (
        <li key={entry.does}>
          <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
        </li>
      ))}
      <li>
        <b>Esc</b> — {t('keys.close')}
      </li>
    </ul>
  )
}

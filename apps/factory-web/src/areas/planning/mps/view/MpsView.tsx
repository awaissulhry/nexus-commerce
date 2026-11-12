'use client'

import { useMemo } from 'react'
import { MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { Button, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { cellHeld } from '../model'
import type { MpsActions, MpsModel } from '../view-model'
import { BulkStrategy } from './BulkStrategy'
import { StrategySection } from './StrategySection'
import '../mps.css'

export type { MpsActions, MpsModel } from '../view-model'

/** The page's words live in the demand page's catalogue (one catalogue for Planning › Long range). */
export const MPS_NAMESPACE = 'planning-demand'
const SCOPE = 'mps'
/** The words both Long range pages say alike (the catalogue's top level). */
const SHARED = ['common.', 'live.', 'strategy.']

/**
 * SCR-202 — Planning › Long range › Master schedule & S&OP (design planning.mps, a workspace list), its W2b part: the band (as
 * of, the site, ⋯ Demand & forecast, Keyboard shortcuts) and Production strategy per item (PLN-061): make to order, make to
 * stock or assemble to order per item, each cell saved by itself, a bulk change with its review and Undo, the reason and the last
 * change from the audit, the design's hint on screen. The master schedule, the season calendar and feasibility and the monthly
 * S&OP are W3 and Later: not drawn (no empty section, no dead door). No page max-width; no money.
 */
export function MpsView({ model, actions }: { model: MpsModel; actions?: MpsActions }) {
  return (
    <WithMessages namespaces={[MPS_NAMESPACE, 'lists']}>
      <MpsScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function useMpsT() {
  const t = useT(MPS_NAMESPACE)
  return useMemo(() => ((key: string, params?: Record<string, string | number>) => (SHARED.some((prefix) => key.startsWith(prefix)) ? t(key, params) : t(`${SCOPE}.${key}`, params))) as typeof t, [t])
}

function MpsScreen({ model, actions }: { model: MpsModel; actions?: MpsActions }) {
  const t = useMpsT()
  const locale = useLocale()
  const words = useMemo(() => ({ t, locale }), [t, locale])

  if (!model.can.view) {
    return (
      <div className="fw-mps">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const page = model.list.status === 'ready' ? model.list.value : null
  const held = cellHeld(model.can)

  return (
    <div className="fw-mps">
      <div className="fw-mps-head">
        <span className="fw-mps-status" role="status">
          {model.list.status === 'loading' ? <Skeleton width={180} height={18} /> : page ? t('page.asOf', { time: formatDateTime(page.asOf, { locale, timeZone: model.timeZone }) }) : null}
          <span>{t(`live.${model.live}`)}</span>
        </span>
        <span className="fw-mps-inline">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-mps-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'demand', label: t('page.demand'), href: `${model.prefix}/planning/demand${model.siteId ? `?site=${encodeURIComponent(model.siteId)}` : ''}` },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {held && <Banner tone="info" title={t('page.readOnly')} />}
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

      <section aria-labelledby="fw-mps-strategy" className="fw-mps-section">
        <div className="fw-mps-section-head">
          <h2 className="fw-mps-h2" id="fw-mps-strategy">
            {t('list.title')}
          </h2>
          <p className="fw-mps-hint">{t('list.purpose')}</p>
        </div>
        <StrategySection model={model} actions={actions} words={words} />
        <p className="fw-mps-hint">{t('list.hint')}</p>
      </section>

      {model.bulk && <BulkStrategy bulk={model.bulk} actions={actions} t={t} />}
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
  const own: ListKey[] = [{ keys: ['Enter'], does: t('keys.edit') }]
  return (
    <ul className="fw-mps-list">
      {listKeys(own, true).map((entry) => (
        <li key={entry.does}>
          <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
        </li>
      ))}
    </ul>
  )
}

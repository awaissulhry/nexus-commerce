'use client'

import Link from 'next/link'
import { CalendarCheck, CopyPlus, GitCompare } from 'lucide-react'
import { Card, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { PriceListDetail } from '../../api'
import { nextVersionHeld } from '../../model'
import { useDay, useValidity, useWords, VersionPill } from '../../parts'
import type { PriceListRecordActions, PriceListRecordModel } from '../record-model'

/**
 * Versions (design pricelist.versions: dated versions; open quotes keep the version they were priced with): each version
 * with its days, its state, how many prices it holds and how many rows changed against the version before (the API's
 * compare), its prices one click away; Make next version (a copy of the newest, one draft at a time), Activate on the
 * draft (the dialog plans the end of the version in force) and Compare two versions. Prices are never shown here: they
 * are on the Prices tab with their grain.
 */
export function VersionsTab({ list, model, actions }: { list: PriceListDetail; model: PriceListRecordModel; actions?: PriceListRecordActions }) {
  const t = useWords()
  const day = useDay()
  const validity = useValidity()
  const nextHeld = nextVersionHeld(list, model.can)
  const busyHeld = model.busy ? t('held.busy') : null
  const versions = [...list.versions].sort((a, b) => b.revision - a.revision)
  const pricesHref = (id: string) => `${model.prefix}/sales/price-lists/${encodeURIComponent(list.id)}?tab=prices&version=${encodeURIComponent(id)}`
  const columns = [t('versions.col.version'), t('versions.col.days'), t('versions.col.status'), t('versions.col.prices'), t('versions.col.changed'), t('versions.col.actions')]
  const rows = versions.map((version) => {
    const changed = model.changedRows[version.id]
    const earlier = list.versions.some((other) => other.revision < version.revision)
    return {
      id: version.id,
      cells: [
        <strong key="v">{t('versions.name', { revision: version.revision })}</strong>,
        <span key="d" className="fw-pl-cell">
          {validity(version.validFrom, version.validTo)}
          {version.activatedAt && <span className="fw-pl-sub">{t('versions.activatedOn', { date: day(version.activatedAt.slice(0, 10)) })}</span>}
        </span>,
        <VersionPill key="s" version={version} today={model.today} />,
        String(version.entries),
        !earlier ? t('versions.first') : changed === undefined || changed === null ? '—' : t('versions.changedCount', { count: changed }),
        <span key="a" className="fw-pl-actions">
          <Button size="sm" variant="quiet" asChild>
            <Link href={pricesHref(version.id)}>{t('versions.openPrices')}</Link>
          </Button>
          {version.status === 'DRAFT' && (
            <Button
              size="sm"
              heldReason={!model.can.manage ? t('held.noManage') : list.status === 'ARCHIVED' ? t('held.archived') : version.entries === 0 ? t('activate.held.noPrices') : busyHeld}
              onClick={() => actions?.onDialog?.({ kind: 'activate', validFrom: '', validTo: version.validTo ?? '' })}
            >
              <CalendarCheck size={13} aria-hidden /> {t('versions.activate')}
            </Button>
          )}
        </span>,
      ],
    }
  })
  return (
    <div className="fw-pl-stack">
      <div className="fw-pl-head">
        <p className="fw-pl-hint">{t('versions.intro')}</p>
        <span className="fw-pl-actions">
          <Button size="sm" heldReason={list.versions.length < 2 ? t('versions.held.compareOne') : null} onClick={() => actions?.onDialog?.({ kind: 'compare' })}>
            <GitCompare size={13} aria-hidden /> {t('versions.compare')}
          </Button>
          <Button size="sm" variant="primary" heldReason={nextHeld ? t(nextHeld) : busyHeld} onClick={() => actions?.onNextVersion?.()}>
            <CopyPlus size={13} aria-hidden /> {t('record.nextVersion')}
          </Button>
        </span>
      </div>
      <Card>
        <div className="fw-pl-table">
          <SummaryTable label={t('versions.table')} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 3 || index === 4 ? 'right' : 'left'))} />
        </div>
      </Card>
      <p className="fw-pl-hint">{t('versions.quotesKeep')}</p>
    </div>
  )
}

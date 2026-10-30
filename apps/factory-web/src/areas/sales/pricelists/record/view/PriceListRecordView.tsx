'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarCheck, CopyPlus, MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type TabItem } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { archiveHeld, nextVersionHeld, RECORD_TABS } from '../../model'
import { Freshness, KindTag, PriceListsMessages, RecordFrame, say, StatePill, useValidity, useWords } from '../../parts'
import type { PriceListRecordProps } from '../record-model'
import { CustomersTab } from './CustomersTab'
import { RecordDialogs } from './Dialogs'
import { PricesTab } from './PricesTab'
import { VersionsTab } from './VersionsTab'

export type { PriceListRecordActions, PriceListRecordModel } from '../record-model'

/**
 * SCR-106 — a price list (design sales.pricelists "Record: Price list", opens as a record page): the band (‹ Price lists,
 * the list's name and code, its state, kind, currency, company and the list it falls back to; ONE primary step — Activate
 * version N while a draft waits, else Make next version — held with its reason in words; ⋯ archive or reactivate, copy
 * the code) and the tabs: Prices (one row per style and colourway: the net unit price autosaved per cell on the draft,
 * the standard cost with the cost grain, the margin % with the margin grain, Raise by % over the rows picked), Customers
 * (who gets it as their default), Versions (dated versions; open quotes keep the one they were priced with; compare,
 * next version, activate) and Activity (the record panels). Breaks & surcharges and the price list PDF are W2b.
 */
export function PriceListRecordView(props: PriceListRecordProps) {
  return (
    <PriceListsMessages>
      <PriceListRecord {...props} />
    </PriceListsMessages>
  )
}

function PriceListRecord({ model, actions, panels }: PriceListRecordProps) {
  const t = useWords()
  const locale = useLocale()
  const validity = useValidity()
  const listHref = `${model.prefix}/sales/price-lists`
  const list = model.list.status === 'ready' ? model.list.value : null
  const base = list ? `${listHref}/${encodeURIComponent(list.id)}` : listHref
  const latest = useRef(actions)
  latest.current = actions

  // ?: every key of the record.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      latest.current?.onDialog?.({ kind: 'help' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog])

  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: tab === 'prices' ? base : `${base}?tab=${tab}`,
    label: t(`tab.${tab}`),
    count: !list ? null : tab === 'prices' ? (model.prices.answer?.entries.length ?? null) : tab === 'customers' ? list.customers.length : tab === 'versions' ? list.versions.length : null,
  }))

  let title: ReactNode = null
  let meta: ReactNode = null
  let bandActions: ReactNode = null
  if (list) {
    const draft = list.versions.find((version) => version.id === list.draftVersionId) ?? null
    const busyHeld = model.busy ? t('held.busy') : null
    const manageHeld = model.can.manage ? null : t('held.noManage')
    const primary = draft ? (
      <Button
        size="sm"
        variant="primary"
        heldReason={manageHeld ?? (list.status === 'ARCHIVED' ? t('held.archived') : draft.entries === 0 ? t('activate.held.noPrices') : busyHeld)}
        onClick={() => actions?.onDialog?.({ kind: 'activate', validFrom: '', validTo: draft.validTo ?? '' })}
      >
        {model.busy && !model.dialog ? <Spinner size={12} /> : <CalendarCheck size={14} aria-hidden />} {t('record.activate', { revision: draft.revision })}
      </Button>
    ) : (
      <Button size="sm" variant="primary" heldReason={(() => { const held = nextVersionHeld(list, model.can); return held ? t(held) : busyHeld })()} onClick={() => actions?.onNextVersion?.()}>
        <CopyPlus size={14} aria-hidden /> {t('record.nextVersion')}
      </Button>
    )
    const archive = archiveHeld(list, model.can)
    bandActions = (
      <span className="fw-pl-actions">
        {primary}
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            { id: 'copy', label: t('record.copyCode'), onSelect: () => actions?.onCopyCode?.() },
            { id: 'versions', label: t('record.toVersions'), href: `${base}?tab=versions` },
            ...(list.status === 'ARCHIVED'
              ? [{ id: 'reactivate', label: t('record.reactivate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }]
              : [{ id: 'archive', label: t('record.archive'), tone: 'danger' as const, disabled: archive !== null, description: say(t, archive) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'archive' }) }]),
          ]}
        />
      </span>
    )
    title = (
      <span className="fw-pl-title">
        {list.name} <span className="fw-pl-title-sub">· {list.code}</span>
      </span>
    )
    meta = (
      <>
        <StatePill state={list.state} />
        <KindTag kind={list.kind} />
        <Tag tone="neutral">{list.currency}</Tag>
        <span className="fw-pl-hint">{list.companyId === null ? t('record.everyCompany') : t('record.ownCompany')}</span>
        {list.shownVersion && <span className="fw-pl-hint">{t('record.shown', { revision: list.shownVersion.revision, days: validity(list.shownVersion.validFrom, list.shownVersion.validTo) })}</span>}
        {list.baseList && (
          <span className="fw-pl-hint">
            {t('record.fallsBack')} <Link href={`${listHref}/${encodeURIComponent(list.baseList.id)}`}>{list.baseList.code}</Link>
          </span>
        )}
      </>
    )
  }

  return (
    <RecordFrame
      backHref={listHref}
      loaded={model.list}
      title={title}
      meta={meta}
      actions={bandActions}
      tabs={tabs}
      tab={model.tab}
      onRetry={actions?.onRetry}
      status={<Freshness asOf={model.asOf} live={model.live} time={(iso) => formatTime(iso, { locale })} />}
    >
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.changedAt && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changedAt, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {list?.status === 'ARCHIVED' && <Banner tone="info" title={t('record.archivedBanner')} />}
      {list && !model.can.manage && list.status !== 'ARCHIVED' && <Banner tone="info" title={t('record.readOnly')} />}
      {list && model.tab === 'prices' && <PricesTab list={list} model={model} actions={actions} />}
      {list && model.tab === 'customers' && <CustomersTab list={list} model={model} actions={actions} />}
      {list && model.tab === 'versions' && <VersionsTab list={list} model={model} actions={actions} />}
      {list && model.tab === 'activity' && (panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null))}
      {list && model.dialog && <RecordDialogs list={list} model={model} actions={actions} />}
    </RecordFrame>
  )
}

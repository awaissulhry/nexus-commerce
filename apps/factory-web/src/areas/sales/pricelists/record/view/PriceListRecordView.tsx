'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { CalendarCheck, CopyPlus } from 'lucide-react'
import { Banner, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { archiveHeld, isWideTab, nextVersionHeld, RECORD_TABS } from '../../model'
import { Freshness, KindTag, PriceListsMessages, RecordState, say, StatePill, useDepthWords, useSayAny, useValidity, useWords } from '../../parts'
// ---- B-TH-258: the price list on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
// B-W2b-343: Breaks & surcharges, the import, the version's export and the price list PDF.
import { exportHref } from '../../depth/api'
import { BreaksTab } from './BreaksTab'
import type { PriceListRecordProps } from '../record-model'
import { CustomersTab } from './CustomersTab'
import { RecordDialogs } from './Dialogs'
import { PricesTab } from './PricesTab'
import { VersionsTab } from './VersionsTab'

export type { PriceListRecordActions, PriceListRecordModel } from '../record-model'

/**
 * SCR-106 — a price list (design sales.pricelists "Record: Price list", opens as a record page), on RecordFrame (B-TH-258; the rule
 * of picture 38): the band in the shell's band row (‹ Price lists, the list's name and code, ONE pill — its state —, kind, currency,
 * company, the version shown, the list it falls back to and the freshness; ONE primary step — Activate version N while a draft
 * waits, else Make next version — held with its reason in words; the Thread button (⌘J); ⋯ copy the code, Versions, the PDF, the
 * exports, Import prices, archive or reactivate, then the frame's Keyboard line) and the tabs 5 → 4: Prices (one row per style and
 * colourway: the net unit price autosaved per cell on the draft, the standard cost with the cost grain, the margin % with the margin
 * grain, Raise by % over the rows picked), Breaks & surcharges, Customers (who gets it as their default), Versions (dated versions;
 * open quotes keep the one they were priced with; compare, next version, activate). The list's thread docked beside every tab —
 * notes only (a list prices many customers: no party, no mail) — Activity's tools in its "⋯" (R-ACT); one third on the wide grids
 * (Prices, Breaks & surcharges) under 1600 px. ONE notice in the body column, the rest behind "N more notices".
 */
export function PriceListRecordView(props: PriceListRecordProps) {
  return (
    <PriceListsMessages>
      <PriceListRecord {...props} />
    </PriceListsMessages>
  )
}

function PriceListRecord({ model, actions, thread, printThread }: PriceListRecordProps) {
  const t = useWords()
  const d = useDepthWords()
  const sayAny = useSayAny()
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
    label: tab === 'breaks' ? d('tab.breaks') : t(`tab.${tab}`),
    count: !list ? null : tab === 'prices' ? (model.prices.answer?.entries.length ?? null) : tab === 'customers' ? list.customers.length : tab === 'versions' ? list.versions.length : tab === 'breaks' && model.breaks?.rules.status === 'ready' ? model.breaks.rules.value.breaks.length + model.breaks.rules.value.sizeSurcharges.length : null,
  }))

  // B-TH-258: the list's states inside the frame (its band, no thread).
  if (!list || model.list.status !== 'ready') {
    const loaded = model.list.status === 'ready' ? ({ status: 'loading' } as const) : model.list
    return (
      <RecordFrame
        recordType="PriceList"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.name'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        <div className="fw-pl">
          <RecordState backHref={listHref} loaded={loaded} onRetry={actions?.onRetry} />
        </div>
      </RecordFrame>
    )
  }

  // B-W2b-343: the version the Prices tab shows (its export and PDF).
  const shownId = model.versionId ?? list.shownVersion?.id ?? null
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
  const more: MenuItemDef[] = [
    { id: 'copy', label: t('record.copyCode'), onSelect: () => actions?.onCopyCode?.() },
    { id: 'versions', label: t('record.toVersions'), href: `${base}?tab=versions` },
    // B-W2b-343: the price list PDF (a print view in a new tab), the version's prices as the import's file, Import prices.
    ...(shownId
      ? [
          { id: 'pdf', label: d('record.pdf'), disabled: !model.can.price, description: model.can.price ? d('record.pdfHint') : d('held.noPrice'), href: model.can.price ? `${base}/print?version=${encodeURIComponent(shownId)}` : undefined, target: '_blank' as const },
          { id: 'export-xlsx', label: d('record.exportXlsx'), disabled: !model.can.price, description: model.can.price ? undefined : d('held.noPrice'), href: model.can.price ? exportHref(list.id, shownId, 'xlsx', locale === 'en' ? 'en' : 'it') : undefined },
          { id: 'export-csv', label: d('record.exportCsv'), disabled: !model.can.price, description: model.can.price ? undefined : d('held.noPrice'), href: model.can.price ? exportHref(list.id, shownId, 'csv', locale === 'en' ? 'en' : 'it') : undefined },
        ]
      : []),
    ...(actions?.onImport ? [{ id: 'import', label: d('record.import'), onSelect: () => actions.onImport?.() }] : []),
    ...(list.status === 'ARCHIVED'
      ? [{ id: 'reactivate', label: t('record.reactivate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }]
      : [{ id: 'archive', label: t('record.archive'), tone: 'danger' as const, disabled: archive !== null, description: say(t, archive) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'archive' }) }]),
  ]
  const title = (
    <span className="fw-pl-title">
      {list.name} <span className="fw-pl-title-sub">· {list.code}</span>
    </span>
  )
  const meta = (
    <>
      <KindTag kind={list.kind} />
      <Tag tone="neutral">{list.currency}</Tag>
      <span className="fw-pl-hint">{list.companyId === null ? t('record.everyCompany') : t('record.ownCompany')}</span>
      {list.shownVersion && <span className="fw-pl-hint">{t('record.shown', { revision: list.shownVersion.revision, days: validity(list.shownVersion.validFrom, list.shownVersion.validTo) })}</span>}
      {list.baseList && (
        <span className="fw-pl-hint">
          {t('record.fallsBack')} <Link href={`${listHref}/${encodeURIComponent(list.baseList.id)}`}>{list.baseList.code}</Link>
        </span>
      )}
      <Freshness asOf={model.asOf} live={model.live} time={(iso) => formatTime(iso, { locale })} />
    </>
  )

  return (
    <RecordFrame
      recordType="PriceList"
      personId={model.personId ?? null}
      threadLabel={t('record.dockLabel')}
      thread={thread ?? null}
      printThread={printThread}
      wide={isWideTab(model.tab)}
      band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title, status: <StatePill state={list.state} />, meta, primary, more, moreLabel: t('record.more') }}
    >
      <div className="fw-pl">
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
        {/* B-TH-258: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={sayAny(model.notice.words) ?? ''}
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
          {list.status === 'ARCHIVED' && <Banner tone="info" title={t('record.archivedBanner')} />}
          {!model.can.manage && list.status !== 'ARCHIVED' && <Banner tone="info" title={t('record.readOnly')} />}
        </RecordNotices>
        {model.tab === 'prices' && <PricesTab list={list} model={model} actions={actions} />}
        {/* B-W2b-343: Breaks & surcharges. */}
        {model.tab === 'breaks' && model.breaks && <BreaksTab list={list} model={model.breaks} actions={{ ...actions?.breaks, onDialog: actions?.onDialog }} />}
        {model.tab === 'customers' && <CustomersTab list={list} model={model} actions={actions} />}
        {model.tab === 'versions' && <VersionsTab list={list} model={model} actions={actions} />}
        {model.dialog && <RecordDialogs list={list} model={model} actions={actions} />}
        {/* B-W2b-343: Import prices (its button lives in the ⋯; the wizard is drawn here). */}
        {model.importer}
      </div>
    </RecordFrame>
  )
}

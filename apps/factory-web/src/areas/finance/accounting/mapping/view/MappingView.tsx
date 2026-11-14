'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Link2, MoreHorizontal, Search } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { accountingHref } from '../../model'
import { ACCOUNTING_NAMESPACES, useAccountingWords } from '../../checks/words'
import { MAPPING_KINDS, type MappingKey, type MappingKind } from '../api'
import { keyId, keysOf, keyWordsOf, mappingHref, MAPPING_VIEWS, viewCounts, type MappingView as View } from '../model'
import type { MappingActions, MappingPageModel } from '../view-model'
import { BulkDialog } from './BulkDialog'
import { JournalsCard, SwitchDialog } from './JournalsCard'
import { KeyDialog } from './KeyDialog'
import '../../../_shared/finance.css'
import '../../accounting.css'
import '../mapping.css'

/** A business day as an instant at noon UTC, so it formats as the same day in Rome. */
const dayInstant = (day: string): string => `${day}T12:00:00Z`

/**
 * SCR-480 — Finance › Close › Accounting export › Account mapping (design finance.accounting h.more "Account mapping (W2b)",
 * conn "Finance › Settings — Account mapping"; FIN-151, FIN-152): ONE place per company for what Nexus posts — an item
 * group, a tax code, a cost category, a payment method, a party group — and the accountant's account it lands in, each
 * row from a day and fixed from then on (a change is a new row from a later day). The band (back to the exports, read
 * at, live, ⋯ Download the mapping), the gate (the accountant confirms; until then made up), the journals switch (off
 * until the accountant confirms; a fresh code), and the keys in the list frame: the kind and the views (all, without an
 * account, changing soon, not posted by Nexus — shown apart), search, a key's dialog, Map N keys, Export N (CSV). No money.
 */
export function MappingView({ model, actions }: { model: MappingPageModel; actions?: MappingActions }) {
  return (
    <WithMessages namespaces={ACCOUNTING_NAMESPACES}>
      <Mapping model={model} actions={actions} />
    </WithMessages>
  )
}

function Mapping({ model, actions }: { model: MappingPageModel; actions?: MappingActions }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [typed, setTyped] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const answer = model.answer
  const query = typed ?? model.address.q

  const rows = useMemo(() => (answer ? keysOf(answer.keys, { kind: model.address.kind, view: model.address.view, q: query }) : null), [answer, model.address.kind, model.address.view, query])
  // The selection is of the keys on screen: a key mapped out of this view (Map N keys) or filtered away leaves it.
  const visible = new Set((rows ?? []).map(keyId))
  const selected = (model.selected ? [...model.selected] : selectedOwn).filter((id) => visible.has(id))
  const counts = answer ? viewCounts(answer.keys, model.address.kind) : null
  const day = (value: string) => formatDate(dayInstant(value), { locale })

  const columns = useMemo<ColDef<MappingKey>[]>(() => {
    const KeyCell = ({ data }: ICellRendererParams<MappingKey>) => {
      if (!data) return null
      const words = keyWordsOf(data, locale)
      return (
        <span className="fw-fac-cell">
          <Link className="fw-fac-link fw-fac-ellipsis" href={mappingHref(model.prefix, { ...model.address, open: keyId(data) })} scroll={false}>
            {words ?? t('mapping.notPosted')}
          </Link>
          <span className="fw-fac-cell-sub">
            <code className="fw-fam-code">{data.key}</code>
            {model.address.kind ? null : ` · ${t(`mapping.kind.${data.kind}`)}`}
          </span>
        </span>
      )
    }
    const AccountCell = ({ data }: ICellRendererParams<MappingKey>) => {
      if (!data) return null
      if (!data.current) {
        return data.posted ? (
          <span className="fw-fac-cell">
            <span className="fw-fac-inline">
              <Pill tone="warning">{t('mapping.noAccount')}</Pill>
            </span>
            <span className="fw-fac-cell-sub">{t('mapping.noAccountSub')}</span>
          </span>
        ) : (
          <span className="fw-fac-muted">{t('mapping.nothingInForce')}</span>
        )
      }
      return (
        <span className="fw-fac-cell">
          <code className="fw-fam-account">{data.current.accountCode}</code>
          <span className="fw-fac-cell-sub">{t('mapping.since', { day: day(data.current.validFrom) })}</span>
        </span>
      )
    }
    const NextCell = ({ data }: ICellRendererParams<MappingKey>) => {
      if (!data) return null
      const next = data.upcoming[0]
      if (!next) return <span className="fw-fac-muted">—</span>
      return (
        <span className="fw-fac-cell">
          <span>
            <code className="fw-fam-account">{next.accountCode}</code> <span className="fw-fac-muted">{t('mapping.from', { day: day(next.validFrom) })}</span>
          </span>
          {data.upcoming.length > 1 && <span className="fw-fac-cell-sub">{t('mapping.moreUpcoming', { count: data.upcoming.length - 1 })}</span>}
        </span>
      )
    }
    const EarlierCell = ({ data }: ICellRendererParams<MappingKey>) => {
      if (!data) return null
      const last = data.earlier[0]
      return last ? (
        <span className="fw-fac-cell">
          <span>{t('mapping.earlierCount', { count: data.earlier.length })}</span>
          <span className="fw-fac-cell-sub">{t('mapping.lastEarlier', { account: last.accountCode, day: day(last.validFrom) })}</span>
        </span>
      ) : (
        <span className="fw-fac-muted">—</span>
      )
    }
    return [
      { colId: 'key', headerName: t('mapping.col.key'), minWidth: 230, flex: 1.8, cellRenderer: KeyCell },
      { colId: 'account', headerName: t('mapping.col.account'), minWidth: 170, flex: 1, cellRenderer: AccountCell },
      { colId: 'next', headerName: t('mapping.col.next'), minWidth: 180, flex: 1, cellRenderer: NextCell },
      { colId: 'earlier', headerName: t('mapping.col.earlier'), minWidth: 170, flex: 1, cellRenderer: EarlierCell },
    ]
  }, [t, locale, model.prefix, model.address])

  if (!model.can.view) {
    return (
      <div className="fw-fac">
        <EmptyState title={t('mapping.noAccess.title')} description={t('mapping.noAccess.body')} />
      </div>
    )
  }

  const picked = (rows ?? []).filter((row) => selected.includes(keyId(row)))
  const bulkHold = model.can.manage ? (picked.some((key) => !key.posted) ? t('mapping.held.bulkNotPosted', { count: picked.filter((key) => !key.posted).length }) : undefined) : t('mapping.held.noManage')
  const state = model.problem ? (
    <EmptyState title={t('mapping.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    query || model.address.kind || model.address.view !== 'all' ? (
      <EmptyState
        title={t('mapping.noMatch.title')}
        description={t(model.address.view === 'other' ? 'mapping.noMatch.other' : 'mapping.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setTyped('')
              actions?.onClear?.()
            }}
          >
            {t('mapping.clear')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('mapping.empty.title')} description={t('mapping.empty.body')} />
    )
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('mapping.search')}
      placeholder={t('mapping.search')}
      value={query}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const tools = (
    <span className="fw-fac-inline">
      <Select size="sm" aria-label={t('mapping.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onKind?.((event.target.value || null) as MappingKind | null)}>
        <option value="">{t('mapping.allKinds')}</option>
        {MAPPING_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`mapping.kind.${kind}`)}
          </option>
        ))}
      </Select>
      <span className="fw-fac-inline" role="group" aria-label={t('mapping.viewsLabel')}>
        {MAPPING_VIEWS.map((view: View) => (
          <FilterChip key={view} pressed={model.address.view === view} count={counts ? String(counts[view]) : undefined} onClick={() => actions?.onView?.(view)}>
            {t(`mapping.view.${view}`)}
          </FilterChip>
        ))}
      </span>
    </span>
  )

  return (
    <div className="fw-fac">
      <div className="fw-fac-band" role="group" aria-label={t('mapping.band')}>
        <span className="fw-fac-stack">
          <h2 className="fw-fac-h2">{t('mapping.title')}</h2>
          <span className="fw-fac-muted">{answer ? t('mapping.lead', { company: answer.company.name }) : t('mapping.leadReading')}</span>
        </span>
        <span className="fw-fac-inline">
          {model.readAt !== null ? <span className="fw-fac-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : null}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
          <Button asChild size="sm">
            <Link href={accountingHref(model.prefix)}>
              <ArrowLeft size={13} aria-hidden /> {t('band.toHistory')}
            </Link>
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('mapping.more') }}
            items={[answer ? { id: 'csv', label: t('mapping.downloadAll'), onSelect: () => actions?.onExport?.(answer.keys) } : { id: 'csv', label: t('mapping.downloadAll'), disabled: true, description: t('mapping.held.reading') }]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone="success"
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <Banner tone="warning" title={t('mapping.gate.title')}>
        {t('mapping.gate.body')}
      </Banner>

      <div className="fw-fam-top">
        <JournalsCard model={model} actions={actions} />
        <Card padded className="fw-fac-card fw-fam-facts" aria-label={t('mapping.factsTitle')}>
          <h3 className="fw-fac-h3">{t('mapping.factsTitle')}</h3>
          {answer ? (
            <ul className="fw-fac-list">
              <li>{t('mapping.facts.keys', { count: viewCounts(answer.keys, null).all })}</li>
              <li>{answer.unmapped > 0 ? t('mapping.facts.unmapped', { count: answer.unmapped }) : t('mapping.facts.allMapped')}</li>
              <li>{t('mapping.facts.rule')}</li>
              <li>{t('mapping.facts.where')}</li>
            </ul>
          ) : (
            <p className="fw-fac-muted">{t(model.problem ? 'mapping.failed' : 'mapping.leadReading')}</p>
          )}
        </Card>
      </div>

      <section className="fw-fac-section" aria-labelledby="fw-fam-keys-title">
        <div className="fw-fac-section-head">
          <h2 className="fw-fac-h2" id="fw-fam-keys-title">
            {t('mapping.keysTitle')}
          </h2>
          <span className="fw-fac-muted">{t(model.address.view === 'other' ? 'mapping.otherLead' : 'mapping.keysLead')}</span>
        </div>
        {model.slow && !answer && !model.problem && (
          <p className="fw-fac-muted" role="status">
            {t('mapping.slow')}
          </p>
        )}
        <ListFrame<MappingKey>
          label={t('mapping.keysTitle')}
          rows={state ? [] : rows}
          rowId={keyId}
          columns={columns}
          count={rows ? t('mapping.count', { count: rows.length }) : '—'}
          search={search}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <span className="fw-fac-inline">
                <Button size="sm" variant="primary" heldReason={bulkHold} aria-label={t('mapping.bulk.map', { count: picked.length })} onClick={() => actions?.onBulk?.(picked)}>
                  <Link2 size={13} aria-hidden /> <SelectionLabel>{t('mapping.bulk.map', { count: picked.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('mapping.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
                  <Download size={13} aria-hidden /> <SelectionLabel>{t('mapping.bulk.export', { count: picked.length })}</SelectionLabel>
                </Button>
              </span>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row)}
          state={state}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
      </section>

      {model.key && <KeyDialog model={model} dialog={model.key} actions={actions} />}
      {model.bulk && <BulkDialog model={model} bulk={model.bulk} actions={actions} />}
      {model.switching && answer && <SwitchDialog model={model} switching={model.switching} settings={answer.journals} unmapped={answer.unmapped} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-fac-list">
            {listKeys([], true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? t('lists:keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? t(`lists:${entry.does}`) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(`finance:${model.stepUp.problem}`) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}

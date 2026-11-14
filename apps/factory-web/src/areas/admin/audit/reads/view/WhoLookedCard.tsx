'use client'

import { useMemo, useState } from 'react'
import { Eye, Search } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { type ColDef } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { cellOf } from '../../../shared/view/cells'
import { FrameState, ListKeysHelp } from '../../../shared/view/parts'
import type { PersonRead, RecordRead } from '../api'
import { reasonProblem, shortId, typeWords } from '../model'
import '../reads.css'

export interface RecordHit {
  type: string
  id: string
  title: string
  number: string | null
}

export interface WhoLookedModel {
  /** The read log is on (null: not known yet). Off on staging and production until the staff notice says so. */
  logging: boolean | null
  mode: 'record' | 'person'
  /** The record whose reads show (record mode). */
  record: RecordHit | null
  search: { query: string; state: 'idle' | 'loading' | 'ready' | 'error'; hits: readonly RecordHit[] }
  /** The office people to pick from; null: the person may not see people (users.view), so person mode is held. */
  people: ReadonlyArray<{ id: string; name: string }> | null
  person: { userId: string; reason: string; tried: boolean }
  rows: { kind: 'record'; reads: readonly RecordRead[] } | { kind: 'person'; name: string; reads: readonly PersonRead[] } | null
  loading: boolean
  /** A failed read (a message key of `admin`). */
  problem: string | null
  nextBefore: string | null
}

export interface WhoLookedActions {
  onMode?: (mode: WhoLookedModel['mode']) => void
  onQuery?: (query: string) => void
  onPick?: (hit: RecordHit) => void
  onClearRecord?: () => void
  onPerson?: (userId: string) => void
  onReason?: (reason: string) => void
  onSearchPerson?: () => void
  onOlder?: () => void
  onRetry?: () => void
}

type Row = RecordRead | PersonRead

/** The reads' columns for each mode (exported: a test draws each cell alone). */
export function readColumns(kind: 'record' | 'person', ctx: { t: Translate; time: (iso: string) => string }): ColDef<Row>[] {
  const { t } = ctx
  return [
    { colId: 'at', headerName: t('reads.col.when'), valueGetter: ({ data }) => data?.at ?? '', width: 180, cellRenderer: cellOf<Row>((row) => ctx.time(row.at)) },
    kind === 'record'
      ? { colId: 'who', headerName: t('reads.col.who'), valueGetter: ({ data }) => (data && 'reader' in data ? (data.reader.name ?? t('reads.who.gone')) : ''), flex: 1.2, minWidth: 180 }
      : {
          colId: 'what',
          headerName: t('reads.col.what'),
          valueGetter: ({ data }) => (data && 'record' in data ? `${typeWords(data.record.type, t)} ${shortId(data.record.id)}` : ''),
          flex: 1.2,
          minWidth: 200,
        },
    { colId: 'how', headerName: t('reads.col.how'), valueGetter: ({ data }) => (data ? t(`reads.action.${data.action}`) : ''), width: 150, cellRenderer: cellOf<Row>((row) => <Tag tone={row.action === 'VIEW' ? 'neutral' : 'info'}>{t(`reads.action.${row.action}`)}</Tag>) },
    { colId: 'where', headerName: t('reads.col.where'), valueGetter: ({ data }) => (data ? t(`reads.surface.${data.surface}`) : ''), width: 140 },
  ]
}

/**
 * Admin › Audit › Who looked (SCR-018 section `reads`, B-W2b-413; PLT-074), administrators and the Owner only: the views,
 * downloads and exports of ONE sensitive record (found by the global search, kinds the read log keeps), or of one person only
 * with a reason (kept first in the person's history). Rows only — never a count, a total or a group per person. When the read
 * log is off (staging and production until the staff notice carries its line: GATE-PRIVACY) it says so first. Fetches
 * nothing (use-who-looked.ts).
 */
export function WhoLookedCard({ model, actions }: { model: WhoLookedModel; actions?: WhoLookedActions }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <WhoLooked model={model} actions={actions} />
    </WithMessages>
  )
}

function WhoLooked({ model, actions }: { model: WhoLookedModel; actions?: WhoLookedActions }) {
  const t = useT('admin-security-depth')
  const locale = useLocale()
  const [help, setHelp] = useState(false)
  const kind = model.rows?.kind ?? model.mode
  const columns = useMemo(() => readColumns(kind, { t, time: (iso) => formatDateTime(iso, { locale }) }), [kind, t, locale])
  const reasonError = model.person.tried ? reasonProblem(model.person.reason) : null
  const rows: readonly Row[] | null = model.loading && !model.rows ? null : (model.rows?.reads ?? null)
  return (
    <section id="reads" aria-labelledby="fw-reads-title" className="fw-reads">
      <Card header={<span id="fw-reads-title">{t('reads.title')}</span>} description={t('reads.hint')} headingLevel={2} padded>
        <div className="fw-reads-stack">
          {model.logging === false && <Banner tone="warning" title={t('reads.off.title')}>{t('reads.off.body')}</Banner>}
          <SegmentedControl
            ariaLabel={t('reads.mode.label')}
            size="sm"
            value={model.mode}
            onChange={(value) => actions?.onMode?.(value as WhoLookedModel['mode'])}
            options={[
              { value: 'record', label: t('reads.mode.record') },
              { value: 'person', label: t('reads.mode.person') },
            ]}
          />
          {model.mode === 'record' ? (
            <div className="fw-reads-pick">
              {model.record ? (
                <p className="fw-reads-row">
                  <span className="fw-adm-hint">{t('reads.record.showing')}</span>
                  <Tag tone="info">{`${typeWords(model.record.type, t)} · ${model.record.number ?? model.record.title}`}</Tag>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onClearRecord?.()}>
                    {t('reads.record.other')}
                  </Button>
                </p>
              ) : (
                <>
                  <Field label={t('reads.record.find')} hint={t('reads.record.findHint')}>
                    <Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} value={model.search.query} onChange={(event) => actions?.onQuery?.(event.target.value)} />
                  </Field>
                  {model.search.state === 'loading' && (
                    <p className="fw-adm-loading" role="status">
                      <Spinner size={14} /> {t('session.stillLoading')}
                    </p>
                  )}
                  {model.search.state === 'error' && <p className="fw-adm-hint">{t('reads.record.searchFailed')}</p>}
                  {model.search.state === 'ready' &&
                    (model.search.hits.length === 0 ? (
                      <p className="fw-adm-hint">{t('reads.record.none')}</p>
                    ) : (
                      <ul className="fw-reads-hits" aria-label={t('reads.record.hits')}>
                        {model.search.hits.map((hit) => (
                          <li key={`${hit.type}.${hit.id}`}>
                            <Button size="sm" variant="quiet" onClick={() => actions?.onPick?.(hit)}>
                              <Eye size={13} aria-hidden /> {hit.number ? `${hit.number} · ${hit.title}` : hit.title}
                            </Button>
                            <span className="fw-adm-hint">{typeWords(hit.type, t)}</span>
                          </li>
                        ))}
                      </ul>
                    ))}
                </>
              )}
            </div>
          ) : model.people === null ? (
            <p className="fw-adm-hint">{t('reads.person.held')}</p>
          ) : (
            <div className="fw-reads-person">
              <Field label={t('reads.person.who')}>
                <Select size="sm" value={model.person.userId} onChange={(event) => actions?.onPerson?.(event.target.value)}>
                  <option value="">{t('reads.person.pick')}</option>
                  {model.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('reads.person.reason')} hint={t('reads.person.reasonHint')} required error={reasonError ? t(reasonError) : undefined}>
                <Textarea rows={2} maxLength={500} value={model.person.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
              </Field>
              <div>
                <Button size="sm" variant="primary" heldReason={model.person.userId === '' ? t('reads.person.pickFirst') : model.loading ? t('reads.held.reading') : null} onClick={() => actions?.onSearchPerson?.()}>
                  {t('reads.person.show')}
                </Button>
              </div>
            </div>
          )}
          {model.rows || model.loading || model.problem ? (
            <>
              {model.rows?.kind === 'person' && <p className="fw-adm-hint">{t('reads.person.showing', { name: model.rows.name })}</p>}
              <ListFrame<Row>
                label={t('reads.title')}
                listKey={null}
                rows={model.problem ? [] : rows}
                rowId={(row) => row.id}
                columns={columns}
                count={model.rows ? t('reads.count', { count: model.rows.reads.length }) : '—'}
                more={model.rows && model.nextBefore ? { label: t('reads.older'), onMore: () => actions?.onOlder?.(), held: model.loading ? t('reads.held.reading') : null } : null}
                onHelp={() => setHelp(true)}
                state={
                  model.problem ? (
                    <FrameState problem={model.problem} onRetry={actions?.onRetry} />
                  ) : model.rows && model.rows.reads.length === 0 ? (
                    <EmptyState title={t('reads.empty.title')} description={t(model.logging === false ? 'reads.empty.off' : 'reads.empty.body')} />
                  ) : undefined
                }
              />
            </>
          ) : (
            <p className="fw-adm-hint">{t(model.mode === 'record' ? 'reads.start.record' : 'reads.start.person')}</p>
          )}
          <p className="fw-adm-hint">{t('reads.rowsOnly')}</p>
        </div>
      </Card>
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
    </section>
  )
}

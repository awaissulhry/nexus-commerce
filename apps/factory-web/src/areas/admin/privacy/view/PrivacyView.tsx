'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, CircleAlert, Clock, Download, ExternalLink, FileLock, FilePlus2, MoreHorizontal, Plus, ShieldAlert } from 'lucide-react'
import { Banner, Card, DateField, EmptyState, Field, FileDropzone, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Input, Pill, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { useKeysHelp } from '../../kit/list'
import type { Activity, CompanyOverview, Dpia, Notice, NoticeKind } from '../api'
import {
  ackWords,
  draftDpiaOf,
  dutiesDone,
  dutyLines,
  languageName,
  languagesInOrder,
  registerRows,
  siteWords,
  storeHeld,
  versionsOf,
  draftOf,
  inForceOf,
  noticeHref,
  publicAddress,
  REGISTER_FILTERS,
  VIEWS,
  type DutyLine,
  type Phrase,
  type PrivacyViewModel,
  type PrivacyViewName,
  type RegisterFilter,
} from '../model'
import { PrivacyDialogs, type DialogActions } from './PrivacyDialogs'
import '../privacy.css'

export type { PrivacyViewModel } from '../model'

export interface PrivacyActions extends DialogActions {
  onCompany?: (companyId: string) => void
  onView?: (view: PrivacyViewName) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onOpenNotice?: (noticeId: string) => void
  onNewNotice?: (kind?: NoticeKind) => void
  onSelectNotices?: (ids: string[]) => void
  onExportNotices?: (ids: string[]) => void
  onCopyAddress?: (address: string) => void
  onStartDpia?: () => void
  onUploadDpia?: (file: File) => void
  onDpiaForm?: (change: Partial<PrivacyViewModel['dpiaForm']>) => void
  onStoreDpia?: () => void
  onOpenFile?: (fileId: string) => void
  onRegisterFilter?: (filter: RegisterFilter) => void
  onSelectActivities?: (ids: string[]) => void
  onExportActivities?: (ids: string[]) => void
  onNewActivity?: () => void
  onOpenActivity?: (activityId: string) => void
  onArchive?: (activityId: string) => void
  onStepUpSubmit?: (code: string) => void
  onStepUpClose?: () => void
}

/** The catalogues the page speaks: its own, the shared Admin words (step-up, problems), the lists'. */
export function PrivacyMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'lists', 'privacy']}>{children}</WithMessages>
}

/**
 * SCR-086 — Admin › Data › Privacy & notices (design admin.privacy; GDPR arts. 13, 28, 30, 35; L. 300/1970 art. 4 c.3):
 * the duties in plain words with the law named and their real state, each site's floor gate, then Notices (the worker
 * notice's versions with who acknowledged them as counts; the staff and the public notice), the DPIA (stored, signed,
 * review day; a new draft with its signed PDF, stored with a fresh code) and the record of processing activities. Every
 * text is a SAMPLE until the privacy consultant writes the real ones, and the page says so at rest. Keys: 1–3 the lists,
 * n a new notice version, ? the keys.
 */
export function PrivacyView({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  return (
    <PrivacyMessages>
      <Privacy model={model} actions={actions} />
    </PrivacyMessages>
  )
}

const DUTY_ICON = { done: CheckCircle2, needs: CircleAlert, review: Clock } as const
const DUTY_TONE = { done: 'success', needs: 'warning', review: 'info' } as const
export const STATUS_TONE = { DRAFT: 'info', PUBLISHED: 'success', SUPERSEDED: 'neutral', STORED: 'success', ACTIVE: 'success', ARCHIVED: 'neutral' } as const

/** A calendar day ("2026-11-16") as a moment at noon UTC (no zone moves it to another day). */
const dayAt = (day: string) => `${day}T12:00:00Z`

function Privacy({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const say = (phrase: Phrase | null | undefined) => (phrase ? t(phrase.key, phrase.params) : null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || model.stepUp.open) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      const index = ['1', '2', '3'].indexOf(event.key)
      if (index >= 0) {
        event.preventDefault()
        actions?.onView?.(VIEWS[index]!)
      } else if (event.key === 'n' && model.can.manage) {
        event.preventDefault()
        actions?.onNewNotice?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view) {
    return (
      <div className="fw-pv">
        <Card padded>
          <EmptyState icon={<FileLock size={22} aria-hidden />} title={admin('record.forbiddenTitle')} description={t('pv.page.noAccess')} />
        </Card>
      </div>
    )
  }

  const companies = model.overview.value ?? []
  const overview = companies.find((entry) => entry.company.id === model.companyId) ?? null
  const lines = overview ? dutyLines(overview, model.today) : []
  const tally = dutiesDone(lines)
  const publicInForce = overview?.notices.PRIVACY_PUBLIC ?? null

  const head = (
    <div className="fw-pv-head">
      <div className="fw-pv-head-text">
        <p className="fw-pv-intro">{overview ? t('pv.page.duties', { done: tally.done, total: tally.total }) : t('pv.page.intro')}</p>
        <span className="fw-pv-asof" role="status">
          {model.asOf ? t('pv.page.updated', { time: formatTime(model.asOf, place) }) : admin('list.notYet')}
          {' · '}
          {t(`pv.live.${model.live}`)}
        </span>
      </div>
      <div className="fw-pv-actions">
        {model.updates > 0 && (
          <Button size="sm" variant="tonal" onClick={actions?.onShowUpdates}>
            {t('pv.page.updates', { count: model.updates })}
          </Button>
        )}
        {companies.length > 1 && (
          <Select size="sm" aria-label={t('pv.page.company')} value={model.companyId ?? ''} onChange={(event) => actions?.onCompany?.(event.target.value)}>
            {companies.map((entry) => (
              <option key={entry.company.id} value={entry.company.id}>
                {entry.company.name}
              </option>
            ))}
          </Select>
        )}
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('pv.page.more') }}
          items={[
            ...(publicInForce && model.companyId
              ? [{ id: 'public', label: t('pv.page.openPublic'), icon: <ExternalLink size={14} aria-hidden />, href: publicAddress('', model.companyId), target: '_blank' as const }]
              : [{ id: 'public', label: t('pv.page.openPublic'), disabled: true, title: t('pv.page.noPublic') }]),
          ]}
        />
        {model.can.manage && (
          <Button size="sm" variant="primary" onClick={() => actions?.onNewNotice?.()} heldReason={overview ? null : t('pv.held.noCompany')}>
            <Plus size={14} aria-hidden /> {t('pv.page.newNotice')}
          </Button>
        )}
      </div>
    </div>
  )

  if (model.overview.problem) {
    return (
      <div className="fw-pv">
        {head}
        <Card padded>
          <EmptyState
            title={admin('list.failedTitle')}
            description={t(model.overview.problem)}
            action={
              <Button size="sm" onClick={actions?.onRetry}>
                {admin('common.retry')}
              </Button>
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="fw-pv">
      {head}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={actions?.onDismissNotice}>
              {admin('common.dismiss')}
            </Button>
          }
        />
      )}
      <Banner tone="warning" icon={<ShieldAlert size={16} aria-hidden />} title={t('pv.sample.title')}>
        {t('pv.sample.body')}
      </Banner>
      {model.overview.value === null ? (
        <Card padded aria-busy="true">
          <p className="fw-pv-loading" role="status">
            <Spinner size={14} /> {admin('list.loading')}
          </p>
          <div className="fw-pv-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={20} />
            ))}
          </div>
        </Card>
      ) : !overview ? (
        <Card padded>
          <EmptyState title={t('pv.page.noCompanyTitle')} description={t('pv.page.noCompany')} />
        </Card>
      ) : (
        <>
          <Duties model={model} overview={overview} lines={lines} actions={actions} />
          <SegmentedControl
            ariaLabel={t('pv.views.label')}
            value={model.view}
            onChange={(value) => actions?.onView?.(value as PrivacyViewName)}
            options={VIEWS.map((view, index) => ({ value: view, label: t(`pv.views.${view}`), title: t('pv.views.key', { key: index + 1 }) }))}
          />
          {model.view === 'notices' && <NoticesView model={model} actions={actions} />}
          {model.view === 'dpia' && <DpiaView model={model} actions={actions} />}
          {model.view === 'register' && <RegisterView model={model} actions={actions} />}
        </>
      )}
      <PrivacyDialogs model={model} actions={actions} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('pv.stepUp.title')}
        sentence={t(model.stepUp.sentence)}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? admin(model.stepUp.problem) : null}
        confirmLabel={t('pv.stepUp.confirm')}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpClose?.()}
      />
    </div>
  )
}

// ---- the duties and the floor gate -----------------------------------------------------------------------------------------

function Duties({ model, overview, lines, actions }: { model: PrivacyViewModel; overview: CompanyOverview; lines: readonly DutyLine[]; actions?: PrivacyActions }) {
  const t = useT('privacy')
  return (
    <div className="fw-pv-top">
      <Card header={t('pv.duties.title')} headingLevel={2} className="fw-pv-card">
        <ol className="fw-pv-duties">
          {lines.map((line) => {
            const Icon = DUTY_ICON[line.state]
            return (
              <li key={line.key} className={`fw-pv-duty is-${line.state}`}>
                <span className="fw-pv-duty-icon" aria-hidden>
                  <Icon size={18} />
                </span>
                <span className="fw-pv-duty-body">
                  <span className="fw-pv-duty-line">
                    <span className="fw-pv-duty-name">{t(`pv.duty.${line.key}.name`)}</span>
                    <Pill tone={DUTY_TONE[line.state]}>{t(`pv.duty.state.${line.state}`)}</Pill>
                  </span>
                  <span className="fw-pv-duty-words">{t(line.words.key, line.words.params)}</span>
                  {line.gates && <span className="fw-pv-duty-gate">{t(line.gates)}</span>}
                  <span className="fw-pv-duty-law">{t(line.law)}</span>
                </span>
                <span className="fw-pv-duty-go">
                  <Button size="sm" variant={line.state === 'needs' ? 'primary' : 'quiet'} onClick={() => actions?.onView?.(line.view)}>
                    {t(line.state === 'needs' ? 'pv.duty.doIt' : 'pv.duty.open')}
                    <span className="fw-pv-sr"> {t(`pv.duty.${line.key}.name`)}</span>
                  </Button>
                </span>
              </li>
            )
          })}
        </ol>
        <p className="fw-pv-later">{t('pv.duties.later')}</p>
      </Card>
      <Card header={t('pv.floor.title')} headingLevel={2} description={t('pv.floor.intro')} className="fw-pv-card">
        {overview.sites.length === 0 ? (
          <p className="fw-pv-muted">{t('pv.floor.noSites')}</p>
        ) : (
          <ul className="fw-pv-sites">
            {overview.sites.map((site) => (
              <li key={site.id} className="fw-pv-site">
                <span className="fw-pv-site-line">
                  <span className="fw-pv-site-name">
                    {site.code} · {site.name}
                  </span>
                  <Pill tone={site.readyForFloor ? 'success' : 'warning'}>{t(site.readyForFloor ? 'pv.floor.ready' : 'pv.floor.held')}</Pill>
                </span>
                {siteWords(site, overview).map((words) => (
                  <span key={words.key} className="fw-pv-site-words">
                    {t(words.key)}
                    {words.key === 'pv.site.noBasis' && (
                      <>
                        {' '}
                        <Link className="fw-pv-link" href={`${model.prefix}/production/settings?site=${encodeURIComponent(site.id)}`}>
                          {t('pv.site.toFloorRules')}
                        </Link>
                      </>
                    )}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ---- notices -----------------------------------------------------------------------------------------------------------------

function useNoticeColumns(model: PrivacyViewModel, actions?: PrivacyActions): ColDef<Notice>[] {
  const t = useT('privacy')
  const locale = useLocale()
  return useMemo(() => {
    const place = { locale, timeZone: model.timeZone }
    const opener = openerOf(actions)
    const VersionCell = ({ data }: ICellRendererParams<Notice>) =>
      data ? (
        <span className="fw-pv-cell">
          <Link className="fw-pv-link" href={noticeHref(model.prefix, model.companyId, data.id)} onClick={opener(data.id)}>
            {t('pv.notice.version', { label: data.label, n: data.versionNo })}
          </Link>
          <span className="fw-pv-sub">{data.publishedAt ? t('pv.notice.publishedOn', { date: formatDate(data.publishedAt, place) }) : t('pv.notice.notPublished')}</span>
        </span>
      ) : null
    const LanguagesCell = ({ data }: ICellRendererParams<Notice>) => (data ? <span className="fw-pv-ellipsis">{languagesInOrder(data.languages).map(languageName).join(' · ') || t('pv.notice.noLanguage')}</span> : null)
    const AckCell = ({ data }: ICellRendererParams<Notice>) => {
      if (!data) return null
      if (data.status === 'DRAFT') return <span className="fw-pv-muted">{t('pv.ack.notYet')}</span>
      const words = ackWords(data.acknowledgements)
      const short = data.acknowledgements && data.acknowledgements.acknowledged < data.acknowledgements.active
      return <span className={short && data.status === 'PUBLISHED' ? 'fw-pv-warning' : undefined}>{t(words.key, words.params)}</span>
    }
    const StateCell = ({ data }: ICellRendererParams<Notice>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`pv.status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'version', headerName: t('pv.col.version'), minWidth: 170, flex: 1.1, cellRenderer: VersionCell },
      { colId: 'languages', headerName: t('pv.col.languages'), minWidth: 170, flex: 1.2, cellRenderer: LanguagesCell },
      { colId: 'acknowledged', headerName: t('pv.col.acknowledged'), minWidth: 150, flex: 1, cellRenderer: AckCell },
      { colId: 'state', headerName: t('pv.col.state'), minWidth: 120, flex: 0.7, cellRenderer: StateCell },
    ]
  }, [t, locale, model.timeZone, model.prefix, model.companyId, actions])
}

/** A plain click opens the dialog in place (the container keeps the address); ⌘ / Ctrl / middle click: a new tab. */
const openerOf = (actions: PrivacyActions | undefined) => (noticeId: string) => (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number; preventDefault: () => void }) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !actions?.onOpenNotice) return
  event.preventDefault()
  actions.onOpenNotice(noticeId)
}

function NoticesView({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  const t = useT('privacy')
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const notices = model.notices.value
  const workers = notices ? versionsOf(notices, 'WORKER_FLOOR') : null
  const columns = useNoticeColumns(model, actions)
  const selected = model.selectedNotices.filter((id) => workers?.some((row) => row.id === id))
  const ownKeys: ListKey[] = [
    { keys: ['1', '2', '3'], does: t('pv.keys.views') },
    ...(model.can.manage ? [{ keys: ['n'], does: t('pv.keys.new') }] : []),
  ]
  const { onHelp, help } = useKeysHelp(ownKeys, true)
  const state = model.notices.problem ? (
    <EmptyState
      title={t('pv.list.failed')}
      description={t(model.notices.problem)}
      action={
        <Button size="sm" onClick={actions?.onRetry}>
          {t('pv.list.retry')}
        </Button>
      }
    />
  ) : workers && workers.length === 0 ? (
    <EmptyState
      title={t('pv.notices.emptyTitle')}
      description={t('pv.notices.empty')}
      action={
        model.can.manage ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onNewNotice?.('WORKER_FLOOR')}>
            <FilePlus2 size={14} aria-hidden /> {t('pv.notices.writeFirst')}
          </Button>
        ) : undefined
      }
    />
  ) : undefined

  return (
    <div className="fw-pv-section">
      <section aria-labelledby="fw-pv-worker" className="fw-pv-block">
        <div className="fw-pv-block-head">
          <h2 id="fw-pv-worker" className="fw-pv-h2">
            {t('pv.notices.workerTitle')}
          </h2>
          <p className="fw-pv-muted">{t('pv.notices.workerIntro')}</p>
        </div>
        <ListFrame<Notice>
          label={t('pv.notices.workerTitle')}
          rows={state ? [] : workers}
          rowId={(row) => row.id}
          columns={columns}
          count={workers ? t('pv.notices.count', { count: workers.length }) : lists('loading')}
          selection={{
            selected,
            onChange: (ids) => actions?.onSelectNotices?.(ids),
            actions: (
              <Button size="sm" aria-label={t('pv.common.export', { count: selected.length })} onClick={() => actions?.onExportNotices?.([...selected])}>
                <Download size={14} aria-hidden /> <SelectionLabel>{t('pv.common.export', { count: selected.length })}</SelectionLabel>
              </Button>
            ),
          }}
          keys={ownKeys}
          onHelp={onHelp}
          keysOpen={model.keysOpen}
          onOpen={(row) => actions?.onOpenNotice?.(row.id)}
          state={state}
        />
        {help}
      </section>

      <Card header={t('pv.notices.otherTitle')} headingLevel={2} description={t('pv.notices.otherIntro')} className="fw-pv-card">
        {notices === null ? (
          <p className="fw-pv-muted" role="status">
            {t('pv.list.loading')}
          </p>
        ) : (
          <SummaryTable
            label={t('pv.notices.otherTitle')}
            density="roomy"
            stackOnPhone
            columns={[t('pv.col.notice'), t('pv.col.inForce'), t('pv.col.acknowledged'), t('pv.col.draft'), t('pv.col.where')]}
            align={['left', 'left', 'left', 'left', 'left']}
            widths={['22%', '20%', '18%', '16%', undefined]}
            rows={(['OFFICE_STAFF', 'PRIVACY_PUBLIC'] as const).map((kind) => {
              const now = inForceOf(notices, kind)
              const draft = draftOf(notices, kind)
              const address = model.companyId ? publicAddress(model.origin, model.companyId) : ''
              return {
                id: kind,
                cells: [
                  <span key="k" className="fw-pv-cell">
                    <strong>{t(`pv.kind.${kind}.name`)}</strong>
                    <span className="fw-pv-sub">{t(`pv.kind.${kind}.who`)}</span>
                  </span>,
                  now ? (
                    <span key="n" className="fw-pv-cell">
                      <Link className="fw-pv-link" href={noticeHref(model.prefix, model.companyId, now.id)} onClick={openerOf(actions)(now.id)}>
                        {t('pv.notice.version', { label: now.label, n: now.versionNo })}
                      </Link>
                      <span className="fw-pv-sub">{now.publishedAt ? t('pv.notice.publishedOn', { date: formatDate(now.publishedAt, place) }) : ''}</span>
                    </span>
                  ) : (
                    <span key="n" className="fw-pv-warning">
                      {t('pv.notices.noneInForce')}
                    </span>
                  ),
                  kind === 'OFFICE_STAFF' && now ? <span key="a">{t(ackWords(now.acknowledgements).key, ackWords(now.acknowledgements).params)}</span> : <span key="a" className="fw-pv-muted">{t(kind === 'PRIVACY_PUBLIC' ? 'pv.ack.public' : 'pv.ack.notYet')}</span>,
                  draft ? (
                    <Link key="d" className="fw-pv-link" href={noticeHref(model.prefix, model.companyId, draft.id)} onClick={openerOf(actions)(draft.id)}>
                      {t('pv.notices.openDraft', { label: draft.label })}
                    </Link>
                  ) : model.can.manage ? (
                    <Button key="d" size="sm" variant="quiet" onClick={() => actions?.onNewNotice?.(kind)}>
                      <Plus size={13} aria-hidden /> {t('pv.notices.newVersion')}
                    </Button>
                  ) : (
                    <span key="d" className="fw-pv-muted">
                      {t('pv.notices.noDraft')}
                    </span>
                  ),
                  kind === 'PRIVACY_PUBLIC' ? (
                    <span key="w" className="fw-pv-copy">
                      <code className="fw-pv-code">{address}</code>
                      <Button size="sm" variant="quiet" onClick={() => actions?.onCopyAddress?.(address)} heldReason={now ? null : t('pv.page.noPublic')}>
                        {t('pv.notices.copy')}
                      </Button>
                    </span>
                  ) : (
                    <span key="w" className="fw-pv-muted">
                      {t('pv.notices.staffWhere')}
                    </span>
                  ),
                ],
              }
            })}
          />
        )}
      </Card>
    </div>
  )
}

// ---- the DPIA ------------------------------------------------------------------------------------------------------------------

function DpiaView({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  const t = useT('privacy')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const day = (value: string | null) => (value ? formatDate(dayAt(value), place) : '—')
  if (model.dpia.problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('pv.list.failed')}
          description={t(model.dpia.problem)}
          action={
            <Button size="sm" onClick={actions?.onRetry}>
              {t('pv.list.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const list = model.dpia.value
  if (!list) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-pv-muted" role="status">
          {t('pv.list.loading')}
        </p>
      </Card>
    )
  }
  const stored = list.stored
  const draft = draftDpiaOf(list)
  const held = storeHeld(draft, model.dpiaForm, model.can, model.today)
  const reviewPassed = stored?.reviewDueOn ? stored.reviewDueOn <= model.today : false
  const fileButton = (dpia: Dpia) =>
    dpia.fileId && model.can.files ? (
      <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(dpia.fileId!)}>
        <ExternalLink size={13} aria-hidden /> {t('pv.dpia.openPdf')}
      </Button>
    ) : dpia.fileId ? (
      <span className="fw-pv-muted">{t('pv.dpia.pdfHere')}</span>
    ) : (
      <span className="fw-pv-warning">{t('pv.dpia.noPdf')}</span>
    )

  return (
    <div className="fw-pv-section fw-pv-dpia">
      <Card header={t('pv.dpia.inForce')} headingLevel={2} description={t('pv.dpia.why')} className="fw-pv-card">
        {stored ? (
          <>
            <KeyValue
              items={[
                { label: t('pv.dpia.version'), value: t('pv.dpia.versionN', { n: stored.versionNo }) },
                { label: t('pv.dpia.signedBy'), value: stored.signedByName ?? '—' },
                { label: t('pv.dpia.signedOn'), value: day(stored.signedOn) },
                { label: t('pv.dpia.reviewDue'), value: <span className={reviewPassed ? 'fw-pv-warning' : undefined}>{reviewPassed ? t('pv.dpia.reviewPassed', { date: day(stored.reviewDueOn) }) : day(stored.reviewDueOn)}</span> },
                { label: t('pv.dpia.storedOn'), value: stored.storedAt ? formatDateTime(stored.storedAt, place) : '—' },
                { label: t('pv.dpia.file'), value: fileButton(stored) },
              ]}
            />
            <p className="fw-pv-scope">{stored.scope}</p>
          </>
        ) : (
          <EmptyState icon={<ShieldAlert size={22} aria-hidden />} title={t('pv.dpia.noneTitle')} description={t('pv.dpia.none')} />
        )}
      </Card>

      <Card
        header={draft ? t('pv.dpia.draftTitle', { n: draft.versionNo }) : t('pv.dpia.newTitle')}
        headingLevel={2}
        description={draft ? t('pv.dpia.draftIntro') : t('pv.dpia.newIntro')}
        className="fw-pv-card"
      >
        {!draft ? (
          model.can.manage ? (
            <Button variant="primary" size="sm" onClick={actions?.onStartDpia}>
              <FilePlus2 size={14} aria-hidden /> {t('pv.dpia.start')}
            </Button>
          ) : (
            <p className="fw-pv-muted">{t('pv.dpia.noDraft')}</p>
          )
        ) : (
          <div className="fw-pv-steps">
            <p className="fw-pv-scope">{draft.scope}</p>
            <div className="fw-pv-step">
              <span className="fw-pv-step-n">{t('pv.dpia.step1')}</span>
              {draft.fileId ? (
                <span className="fw-pv-inline">
                  <Pill tone="success">{t('pv.dpia.pdfUploaded')}</Pill>
                  {fileButton(draft)}
                </span>
              ) : null}
              {model.can.upload ? <DpiaDrop busy={model.uploading} replace={draft.fileId !== null} onFile={(file) => actions?.onUploadDpia?.(file)} /> : !draft.fileId ? <span className="fw-pv-muted">{t('pv.held.upload')}</span> : null}
            </div>
            <div className="fw-pv-step">
              <span className="fw-pv-step-n">{t('pv.dpia.step2')}</span>
              <DpiaForm model={model} actions={actions} />
            </div>
            {model.dpiaProblem && <Banner tone="danger" title={t(model.dpiaProblem.key, model.dpiaProblem.params)} />}
            <div className="fw-pv-actions">
              <Button variant="primary" onClick={actions?.onStoreDpia} heldReason={held ? t(held.key, held.params) : null}>
                {t('pv.dpia.store')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card header={t('pv.dpia.versions')} headingLevel={2} className="fw-pv-card fw-pv-wide">
        {list.versions.length === 0 ? (
          <p className="fw-pv-muted">{t('pv.dpia.noVersions')}</p>
        ) : (
          <SummaryTable
            label={t('pv.dpia.versions')}
            stackOnPhone
            columns={[t('pv.dpia.version'), t('pv.col.state'), t('pv.dpia.signedBy'), t('pv.dpia.signedOn'), t('pv.dpia.reviewDue'), t('pv.dpia.storedOn')]}
            align={['left', 'left', 'left', 'left', 'left', 'left']}
            rows={[...list.versions]
              .sort((a, b) => b.versionNo - a.versionNo)
              .map((dpia) => ({
                id: dpia.id,
                cells: [
                  t('pv.dpia.versionN', { n: dpia.versionNo }),
                  <Pill key="s" tone={STATUS_TONE[dpia.status]}>
                    {t(`pv.dpiaStatus.${dpia.status}`)}
                  </Pill>,
                  dpia.signedByName ?? '—',
                  day(dpia.signedOn),
                  day(dpia.reviewDueOn),
                  dpia.storedAt ? formatDate(dpia.storedAt, place) : '—',
                ],
              }))}
          />
        )}
      </Card>
    </div>
  )
}

/** The signed PDF (one file; the dropzone's own words are the DS's). */
function DpiaDrop({ busy, replace, onFile }: { busy: boolean; replace: boolean; onFile: (file: File) => void }) {
  const t = useT('privacy')
  return (
    <div className="fw-pv-drop">
      <FileDropzone accept=".pdf" maxBytes={20 * 1024 * 1024} disabled={busy} hint={t(replace ? 'pv.dpia.replacePdf' : 'pv.dpia.dropPdf')} onFiles={(files) => files[0] && onFile(files[0])} />
    </div>
  )
}

function DpiaForm({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  const t = useT('privacy')
  const locale = useLocale()
  const editable = model.can.manage
  return (
    <div className="fw-pv-form">
      <Field label={t('pv.dpia.signedBy')} hint={t('pv.dpia.signedByHint')} required>
        <Input value={model.dpiaForm.signedByName} disabled={!editable} onChange={(event) => actions?.onDpiaForm?.({ signedByName: event.target.value })} />
      </Field>
      <Field label={t('pv.dpia.signedOn')} required>
        <DateField value={model.dpiaForm.signedOn} locale={locale === 'it' ? 'it-IT' : 'en-GB'} max={model.today} onChange={(value) => actions?.onDpiaForm?.({ signedOn: value })} />
      </Field>
      <Field label={t('pv.dpia.reviewDue')} hint={t('pv.dpia.reviewHint')} required>
        <DateField value={model.dpiaForm.reviewDueOn} locale={locale === 'it' ? 'it-IT' : 'en-GB'} onChange={(value) => actions?.onDpiaForm?.({ reviewDueOn: value })} />
      </Field>
    </div>
  )
}

// ---- the record of processing activities ------------------------------------------------------------------------------------

function useActivityColumns(model: PrivacyViewModel, actions?: PrivacyActions): ColDef<Activity>[] {
  const t = useT('privacy')
  return useMemo(() => {
    const list = (values: readonly string[]) => (values.length > 0 ? values.join(' · ') : '—')
    const NameCell = ({ data }: ICellRendererParams<Activity>) =>
      data ? (
        <span className="fw-pv-cell">
          <Button variant="link" inline className="fw-pv-linkbtn" onClick={() => actions?.onOpenActivity?.(data.id)}>
            {data.name}
          </Button>
          <span className="fw-pv-sub fw-pv-mono">{data.code}</span>
        </span>
      ) : null
    const Two = (first: (row: Activity) => string, second: (row: Activity) => string) =>
      function TwoCell({ data }: ICellRendererParams<Activity>) {
        return data ? (
          <span className="fw-pv-cell">
            <span className="fw-pv-ellipsis" title={first(data)}>
              {first(data)}
            </span>
            <span className="fw-pv-sub" title={second(data)}>
              {second(data)}
            </span>
          </span>
        ) : null
      }
    const StateCell = ({ data }: ICellRendererParams<Activity>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`pv.activityStatus.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<Activity>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('pv.register.rowMenu', { name: data.name }) }}
          items={[
            { id: 'open', label: t(model.can.manage && data.status === 'ACTIVE' ? 'pv.register.edit' : 'pv.register.view'), onSelect: () => actions?.onOpenActivity?.(data.id) },
            ...(model.can.manage && data.status === 'ACTIVE' ? [{ id: 'archive', label: t('pv.register.archive'), tone: 'danger' as const, onSelect: () => actions?.onArchive?.(data.id) }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'name', headerName: t('pv.col.activity'), minWidth: 200, flex: 1.3, cellRenderer: NameCell },
      { colId: 'purpose', headerName: t('pv.col.purpose'), minWidth: 220, flex: 1.5, cellRenderer: Two((row) => row.purpose, (row) => row.legalBasis) },
      { colId: 'people', headerName: t('pv.col.people'), minWidth: 200, flex: 1.3, cellRenderer: Two((row) => list(row.dataSubjects), (row) => list(row.dataCategories)) },
      { colId: 'processors', headerName: t('pv.col.processors'), minWidth: 210, flex: 1.3, cellRenderer: Two((row) => list(row.processors), (row) => list(row.recipients)) },
      { colId: 'retention', headerName: t('pv.col.retention'), minWidth: 170, flex: 1, cellRenderer: Two((row) => row.retention, (row) => row.transfers) },
      { colId: 'state', headerName: t('pv.col.state'), minWidth: 110, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('pv.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, model.can.manage, actions])
}

function RegisterView({ model, actions }: { model: PrivacyViewModel; actions?: PrivacyActions }) {
  const t = useT('privacy')
  const lists = useT('lists')
  const all = model.register.value
  const rows = all ? registerRows(all, model.registerFilter) : null
  const columns = useActivityColumns(model, actions)
  const selected = model.selectedActivities.filter((id) => rows?.some((row) => row.id === id))
  const registerKeys: ListKey[] = [{ keys: ['1', '2', '3'], does: t('pv.keys.views') }]
  const { onHelp, help } = useKeysHelp(registerKeys, true)
  const state = model.register.problem ? (
    <EmptyState
      title={t('pv.list.failed')}
      description={t(model.register.problem)}
      action={
        <Button size="sm" onClick={actions?.onRetry}>
          {t('pv.list.retry')}
        </Button>
      }
    />
  ) : all && all.length === 0 ? (
    <EmptyState
      title={t('pv.register.emptyTitle')}
      description={t('pv.register.empty')}
      action={
        model.can.manage ? (
          <Button size="sm" variant="primary" onClick={actions?.onNewActivity}>
            <Plus size={14} aria-hidden /> {t('pv.register.new')}
          </Button>
        ) : undefined
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      title={t('pv.register.noneHere')}
      action={
        <Button size="sm" onClick={() => actions?.onRegisterFilter?.('all')}>
          {t('pv.register.showAll')}
        </Button>
      }
    />
  ) : undefined
  return (
    <section className="fw-pv-block" aria-labelledby="fw-pv-register">
      <div className="fw-pv-block-head">
        <h2 id="fw-pv-register" className="fw-pv-h2">
          {t('pv.register.title')}
        </h2>
        <p className="fw-pv-muted">{t('pv.register.intro')}</p>
      </div>
      <ListFrame<Activity>
        label={t('pv.register.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('pv.register.count', { count: rows.length }) : lists('loading')}
        tools={
          <Select size="sm" aria-label={t('pv.register.filter')} value={model.registerFilter} onChange={(event) => actions?.onRegisterFilter?.(event.target.value as RegisterFilter)}>
            {REGISTER_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {t(`pv.register.filters.${filter}`)}
              </option>
            ))}
          </Select>
        }
        right={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={actions?.onNewActivity}>
              <Plus size={14} aria-hidden /> {t('pv.register.new')}
            </Button>
          ) : undefined
        }
        selection={{
          selected,
          onChange: (ids) => actions?.onSelectActivities?.(ids),
          actions: (
            <Button size="sm" aria-label={t('pv.common.export', { count: selected.length })} onClick={() => actions?.onExportActivities?.([...selected])}>
              <Download size={14} aria-hidden /> <SelectionLabel>{t('pv.common.export', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={registerKeys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpenActivity?.(row.id)}
        state={state}
      />
      {help}
    </section>
  )
}


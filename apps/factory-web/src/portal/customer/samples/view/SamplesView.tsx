'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { AlertCircle, ClipboardCheck, Download, FileText, Lock, Shirt, Truck } from 'lucide-react'
import { Banner, EmptyState, Thumbnail } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { ActionList, type ActionGroup } from '@nexus/ui/patterns/ActionList/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { RoundRead, StyleRead, WaitingRead } from '../api'
import { decisionWhat, dueStateOf, roundTone, techPackTone, trackingText } from '../model'
import { useSamplesWords } from '../words'
import { DecisionDialog, type DecisionActions, type DecisionDialogModel } from './DecisionDialog'
import '../samples.css'

/**
 * SCR-225 — the brand's Samples & tech packs (design portal.customer.samples; PRD-245, Owner answer T3): Waiting for your
 * decision (the DS ActionList: the sample, its style, when it reached you, by when — Decide opens "Decide on Fit 2"),
 * Your styles in development (the shared list frame: the brand's own styles only, their stage, latest round, next date,
 * what waits, the tech pack PDF of the version we shared — a new tab, logged; select styles to download their PDFs),
 * Sample rounds (every round with its status and shipment, tracking in a new tab; a row opens its decision when it waits,
 * else the round's page with its messages; select waiting rounds to decide them one after the other). No money on any
 * section. No connection or an office preview: what sends is held with the reason. Fills the main area (no page
 * max-width). Draws one view model and fetches nothing.
 */

type Held = { key: string; params?: Readonly<Record<string, string | number>> } | null

export interface SamplesViewModel {
  state: 'loading' | 'error' | 'ready'
  /** The read takes longer than a second. */
  slow?: boolean
  /** The page's clock (countdowns; design cases). */
  now: number
  prefix: string
  /** Null: the person's role does not read approvals (one line says so, naming the admins). */
  waiting: readonly WaitingRead[] | null
  styles: readonly StyleRead[]
  /** The rounds shown (one style's when `styleFilter`). */
  rounds: readonly RoundRead[]
  roundsTotal: number
  styleFilter: { id: string; code: string } | null
  selectedStyles: readonly string[]
  selectedRounds: readonly string[]
  /** Why a tech pack may not be opened now (an office preview, no connection). */
  openHeld: Held
  /** Why a decision may not be opened from a list now (nothing: deciding is always opened; the dialog says why it is held). */
  busyPack: string | null
  admins: readonly string[]
  /** A refused open or a line about the address, a key with its words. */
  problem: { key: string; params?: Readonly<Record<string, string | number>>; tone: 'warning' | 'info' } | null
  decision: DecisionDialogModel | null
  /** Design cases: a list's keys panel open. */
  keysOpen?: 'styles' | 'rounds' | null
}

export interface SamplesViewActions {
  onRetry?: () => void
  onDecide?: (requestId: string, queue?: readonly string[]) => void
  onStyle?: (style: StyleRead) => void
  onAllRounds?: () => void
  onTechPack?: (style: StyleRead) => void
  onSelectStyles?: (ids: string[]) => void
  onSelectRounds?: (ids: string[]) => void
  onDownloadPacks?: (styleIds: readonly string[]) => void
  onOpenRound?: (round: RoundRead) => void
  onDismissProblem?: () => void
  onHelp?: () => void
  decision?: DecisionActions
}

export function SamplesView({ model, actions }: { model: SamplesViewModel; actions?: SamplesViewActions }) {
  const { t } = useSamplesWords()
  return (
    <div className="fw-psmp">
      {model.problem ? (
        <Banner
          tone={model.problem.tone}
          title={t(model.problem.key, model.problem.params)}
          action={actions?.onDismissProblem ? <Button size="sm" variant="quiet" onClick={actions.onDismissProblem}>{t('state.hide')}</Button> : undefined}
        />
      ) : null}
      {model.state === 'error' ? (
        <div className="fw-psmp-state" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('state.failed')}</span>
          <Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>
        </div>
      ) : null}
      <WaitingSection model={model} actions={actions} />
      <StylesSection model={model} actions={actions} />
      <RoundsSection model={model} actions={actions} />
      {model.decision ? <DecisionDialog model={model.decision} actions={actions?.decision} /> : null}
    </div>
  )
}

function SectionHead({ id, title, hint, icon }: { id: string; title: string; hint: string; icon: ReactNode }) {
  return (
    <div className="fw-psmp-head">
      <span className="fw-psmp-head-icon" aria-hidden>
        {icon}
      </span>
      <div className="fw-psmp-headtext">
        <h2 id={id} className="fw-psmp-h2">
          {title}
        </h2>
        <p className="fw-psmp-sub">{hint}</p>
      </div>
    </div>
  )
}

function Loading({ slow, label }: { slow?: boolean; label: string }) {
  const { t } = useSamplesWords()
  return (
    <div className="fw-psmp-stack" role="status" aria-label={label}>
      <Skeleton height={56} />
      <Skeleton height={56} />
      {slow ? <p className="fw-psmp-sub">{t('state.slow')}</p> : null}
    </div>
  )
}

// ── Waiting for your decision ─────────────────────────────────────────────────────────────────────────────────────────
function WaitingSection({ model, actions }: { model: SamplesViewModel; actions?: SamplesViewActions }) {
  const { t, locale, day } = useSamplesWords()
  const ds = useDsWords()
  const rows = model.waiting
  const queue = (rows ?? []).map((row) => row.requestId)
  const groups: ActionGroup[] = rows
    ? [
        {
          id: 'samples',
          label: t('waiting.group'),
          items: rows.map((row) => ({
            id: row.requestId,
            title: t('waiting.rowTitle', { what: decisionWhat(row, t, locale) }),
            record: <span className="fw-psmp-record">{row.style ? t('waiting.style', { code: row.style.code, name: row.style.name }) : row.label[locale]}</span>,
            meta: row.receivedAt ? t('waiting.received', { date: day(row.receivedAt) }) : t('waiting.asked', { date: day(row.askedAt) }),
            due: { at: row.dueAt, state: dueStateOf(row.dueAt, model.now), text: day(row.dueAt) },
            verb: { label: t('waiting.decide'), kind: 'dialog' as const, onRun: () => actions?.onDecide?.(row.requestId, queue) },
          })),
        },
      ]
    : []
  return (
    <section className="fw-psmp-section" aria-labelledby="fw-psmp-waiting">
      <SectionHead id="fw-psmp-waiting" title={t('waiting.title')} hint={t('waiting.hint')} icon={<ClipboardCheck size={18} />} />
      {model.state === 'loading' ? (
        <Loading slow={model.slow} label={t('state.loading')} />
      ) : model.state === 'error' ? null : rows === null ? (
        <p className="fw-psmp-line">
          <Lock size={14} aria-hidden /> {model.admins.length > 0 ? t('waiting.noAccessAsk', { admins: model.admins.join(', ') }) : t('waiting.noAccess')}
        </p>
      ) : (
        <ActionList groups={groups} headingLevel={3} sort={false} empty={t('waiting.empty')} labels={ds.actionList} countdownLabels={ds.countdown} now={model.now} />
      )}
    </section>
  )
}

// ── Your styles in development ────────────────────────────────────────────────────────────────────────────────────────
function StylesSection({ model, actions }: { model: SamplesViewModel; actions?: SamplesViewActions }) {
  const { t, day } = useSamplesWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo((): ColDef<StyleRead>[] => {
    const StyleCell = ({ data }: ICellRendererParams<StyleRead>) =>
      data ? (
        <span className="fw-psmp-style">
          <Thumbnail src={null} alt="" hoverPreview={false} />
          <span className="fw-psmp-two">
            <span className="fw-psmp-strong fw-psmp-ellipsis" title={data.code}>
              {data.code}
            </span>
            <span className="fw-psmp-sub fw-psmp-ellipsis" title={data.name}>
              {data.name}
            </span>
          </span>
        </span>
      ) : null
    const StageCell = ({ data }: ICellRendererParams<StyleRead>) => (data ? <Pill tone={data.stage === 'APPROVED' ? 'success' : 'info'}>{t(`stage.${data.stage}`)}</Pill> : null)
    const RoundCell = ({ data }: ICellRendererParams<StyleRead>) =>
      data?.latestRound ? (
        <span className="fw-psmp-two">
          <span className="fw-psmp-ellipsis">{t('round.label', { kind: t(`kind.${data.latestRound.kind}`), n: data.latestRound.roundNo })}</span>
          <span className="fw-psmp-sub fw-psmp-ellipsis">{t(`status.${data.latestRound.status}`)}</span>
        </span>
      ) : (
        <span className="fw-psmp-sub">{t('styles.noRound')}</span>
      )
    const PackCell = ({ data }: ICellRendererParams<StyleRead>) => {
      if (!data) return null
      const now = latest.current.model
      const pack = data.techPack
      if (!pack) return <span className="fw-psmp-sub">{t('pack.none')}</span>
      const held = now.openHeld ? t(now.openHeld.key, now.openHeld.params) : now.busyPack === data.id ? t('pack.opening') : null
      return (
        <span className="fw-psmp-pack">
          <Button size="sm" heldReason={held} aria-label={t('pack.openOf', { code: data.code, version: pack.version, revision: pack.revision })} onClick={() => latest.current.actions?.onTechPack?.(data)}>
            <FileText size={14} aria-hidden /> <span className="fw-psmp-nowrap">{t('pack.version', { revision: pack.revision, version: pack.version, language: pack.language.toUpperCase() })}</span>
          </Button>
          <span title={t(`pack.stateHint.${pack.state}`)}>
            <Pill tone={techPackTone(pack.state)}>{t(`pack.state.${pack.state}`)}</Pill>
          </span>
        </span>
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<StyleRead>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<StyleRead> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      { ...column('style', t('styles.col.style'), StyleCell, { flex: 1.3, minWidth: 200 }), valueGetter: ({ data }) => (data ? `${data.code} ${data.name}` : '') },
      { ...column('season', t('styles.col.season'), undefined, { flex: 0.4, minWidth: 100 }), valueGetter: ({ data }) => data?.season ?? '—' },
      { ...column('stage', t('styles.col.stage'), StageCell, { flex: 0.9, minWidth: 200 }), valueGetter: ({ data }) => (data ? t(`stage.${data.stage}`) : '') },
      { ...column('round', t('styles.col.round'), RoundCell, { flex: 1, minWidth: 160 }), valueGetter: ({ data }) => (data?.latestRound ? t('round.label', { kind: t(`kind.${data.latestRound.kind}`), n: data.latestRound.roundNo }) : '') },
      { ...column('next', t('styles.col.next'), undefined, { flex: 0.5, minWidth: 130 }), valueGetter: ({ data }) => (data?.nextDate ? day(data.nextDate) : '—') },
      { ...column('pack', t('styles.col.pack'), PackCell, { flex: 1.1, minWidth: 250 }), valueGetter: ({ data }) => (data?.techPack ? t('pack.version', { revision: data.techPack.revision, version: data.techPack.version, language: data.techPack.language.toUpperCase() }) : t('pack.none')) },
    ]
  }, [t, day])

  const selected = model.selectedStyles
  const withPack = selected.filter((id) => model.styles.some((style) => style.id === id && style.techPack))
  const bulkHeld = model.openHeld ? t(model.openHeld.key, model.openHeld.params) : withPack.length === 0 ? t('styles.bulkNone') : null
  const bulk = (
    <Button size="sm" heldReason={bulkHeld} onClick={() => actions?.onDownloadPacks?.(withPack)} aria-label={t('styles.bulk', { count: withPack.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('styles.bulk', { count: withPack.length })}</SelectionLabel>
    </Button>
  )
  const state: ReactNode = model.state === 'error' ? <EmptyState title={t('styles.failed')} description={t('state.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} /> : model.state === 'ready' && model.styles.length === 0 ? <EmptyState icon={<Shirt size={24} aria-hidden />} title={t('styles.empty')} description={t('styles.emptyBody')} /> : undefined
  return (
    <section className="fw-psmp-section" aria-labelledby="fw-psmp-styles">
      <SectionHead id="fw-psmp-styles" title={t('styles.title')} hint={t('styles.hint')} icon={<Shirt size={18} />} />
      <ListFrame<StyleRead>
        label={t('styles.label')}
        title={t('styles.title')}
        listKey={null}
        rows={model.state === 'loading' ? null : model.state === 'error' ? [] : model.styles}
        rowId={(row) => row.id}
        columns={columns}
        count={model.state === 'ready' ? t('styles.count', { count: model.styles.length }) : ''}
        selection={{ selected: [...selected], onChange: (ids) => actions?.onSelectStyles?.(ids), actions: bulk }}
        isRowSelectable={(row) => (row.techPack ? null : t('styles.noPackToSelect'))}
        keys={[{ keys: ['↵'], does: t('keys.styleRounds') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onStyle?.(row)}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen === 'styles'}
      />
    </section>
  )
}

// ── Sample rounds ─────────────────────────────────────────────────────────────────────────────────────────────────────
function RoundsSection({ model, actions }: { model: SamplesViewModel; actions?: SamplesViewActions }) {
  const { t, day } = useSamplesWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo((): ColDef<RoundRead>[] => {
    const RoundCell = ({ data }: ICellRendererParams<RoundRead>) =>
      data ? (
        <span className="fw-psmp-two">
          <span className="fw-psmp-strong fw-psmp-ellipsis">{t('round.label', { kind: t(`kind.${data.kind}`), n: data.roundNo })}</span>
          <span className="fw-psmp-sub fw-psmp-mono">{data.number}</span>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<RoundRead>) =>
      data ? (
        <span className="fw-psmp-two">
          <span className="fw-psmp-ellipsis">{data.style.code}</span>
          <span className="fw-psmp-sub fw-psmp-ellipsis" title={data.style.name}>
            {data.style.name}
          </span>
        </span>
      ) : null
    const TrackingCell = ({ data }: ICellRendererParams<RoundRead>) => {
      if (!data) return null
      const text = trackingText(data.shipment)
      if (!text) return <span className="fw-psmp-sub">{data.shipment ? t('rounds.noTracking') : '—'}</span>
      const url = data.shipment?.trackingUrl
      return url ? (
        <a className="fw-psmp-ellipsis" href={url} target="_blank" rel="noreferrer noopener" aria-label={t('rounds.trackOf', { tracking: text })}>
          <Truck size={14} aria-hidden /> {text}
        </a>
      ) : (
        <span className="fw-psmp-ellipsis">{text}</span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<RoundRead>) =>
      data ? (
        <span className="fw-psmp-two">
          <Pill tone={roundTone(data.status)}>{t(`status.${data.status}`)}</Pill>
          {data.decidedAt ? <span className="fw-psmp-sub">{t('rounds.decidedOn', { date: day(data.decidedAt) })}</span> : data.dueDate ? <span className="fw-psmp-sub">{t('rounds.dueOn', { date: day(data.dueDate) })}</span> : null}
        </span>
      ) : null
    const column = (colId: string, header: string, cellRenderer: ColDef<RoundRead>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<RoundRead> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      { ...column('round', t('rounds.col.round'), RoundCell, { flex: 1.1, minWidth: 190 }), valueGetter: ({ data }) => (data ? `${t('round.label', { kind: t(`kind.${data.kind}`), n: data.roundNo })} · ${data.number}` : '') },
      { ...column('style', t('rounds.col.style'), StyleCell, { flex: 1, minWidth: 170 }), valueGetter: ({ data }) => (data ? `${data.style.code} ${data.style.name}` : '') },
      { ...column('pieces', t('rounds.col.pieces'), undefined, { flex: 0.4, minWidth: 84 }), valueGetter: ({ data }) => (data ? String(data.pieces) : '') },
      { ...column('sent', t('rounds.col.sent'), undefined, { flex: 0.6, minWidth: 110 }), valueGetter: ({ data }) => (data?.shipment?.sentAt ? day(data.shipment.sentAt) : '—') },
      { ...column('received', t('rounds.col.received'), undefined, { flex: 0.6, minWidth: 110 }), valueGetter: ({ data }) => (data?.shipment?.receivedAt ? day(data.shipment.receivedAt) : '—') },
      { ...column('tracking', t('rounds.col.tracking'), TrackingCell, { flex: 1, minWidth: 170 }), valueGetter: ({ data }) => (data ? (trackingText(data.shipment) ?? '—') : '') },
      { ...column('status', t('rounds.col.status'), StatusCell, { flex: 1, minWidth: 190 }), valueGetter: ({ data }) => (data ? t(`status.${data.status}`) : '') },
    ]
  }, [t, day])

  const selected = model.selectedRounds
  const waitingIds = selected.flatMap((id) => model.rounds.find((round) => round.id === id && round.waitingRequestId)?.waitingRequestId ?? [])
  const bulkHeld = waitingIds.length === 0 ? t('rounds.bulkNone') : null
  const bulk = (
    <Button size="sm" heldReason={bulkHeld} onClick={() => waitingIds[0] && actions?.onDecide?.(waitingIds[0], waitingIds)} aria-label={t('rounds.bulk', { count: waitingIds.length })}>
      <ClipboardCheck size={13} aria-hidden /> <SelectionLabel>{t('rounds.bulk', { count: waitingIds.length })}</SelectionLabel>
    </Button>
  )
  const filtered = model.styleFilter
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('rounds.failed')} description={t('state.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : model.state === 'ready' && model.rounds.length === 0 ? (
      filtered ? (
        <EmptyState title={t('rounds.noneOf', { code: filtered.code })} action={<Button size="sm" onClick={() => actions?.onAllRounds?.()}>{t('rounds.showAll')}</Button>} />
      ) : (
        <EmptyState icon={<Truck size={24} aria-hidden />} title={t('rounds.empty')} description={t('rounds.emptyBody')} />
      )
    ) : undefined
  return (
    <section className="fw-psmp-section" aria-labelledby="fw-psmp-rounds">
      <SectionHead id="fw-psmp-rounds" title={t('rounds.title')} hint={t('rounds.hint')} icon={<Truck size={18} />} />
      <ListFrame<RoundRead>
        label={t('rounds.label')}
        title={t('rounds.title')}
        listKey={null}
        rows={model.state === 'loading' ? null : model.state === 'error' ? [] : model.rounds}
        rowId={(row) => row.id}
        columns={columns}
        count={model.state === 'ready' ? (filtered ? t('rounds.countOf', { count: model.rounds.length, total: model.roundsTotal, code: filtered.code }) : t('rounds.count', { count: model.rounds.length })) : ''}
        tools={
          filtered ? (
            <span className="fw-psmp-filter">
              <Pill tone="info">{t('rounds.only', { code: filtered.code })}</Pill>
              <Button size="sm" variant="quiet" onClick={() => actions?.onAllRounds?.()}>
                {t('rounds.showAll')}
              </Button>
            </span>
          ) : undefined
        }
        selection={{ selected: [...selected], onChange: (ids) => actions?.onSelectRounds?.(ids), actions: bulk }}
        keys={[{ keys: ['↵'], does: t('keys.openRound') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => (row.waitingRequestId ? actions?.onDecide?.(row.waitingRequestId) : actions?.onOpenRound?.(row))}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen === 'rounds'}
      />
    </section>
  )
}

/** A role the page does not open (fails closed: it is not in the navigation; a typed address says so). */
export function SamplesClosedView({ model }: { model: { homeHref: string; admins: readonly string[] } }) {
  const { t } = useSamplesWords()
  return (
    <div className="fw-psmp">
      <EmptyState
        icon={<Lock size={24} aria-hidden />}
        title={t('noAccess.title')}
        description={model.admins.length > 0 ? t('noAccess.bodyAsk', { admins: model.admins.join(', ') }) : t('noAccess.body')}
        action={
          <Button asChild>
            <a href={model.homeHref}>{t('noAccess.home')}</a>
          </Button>
        }
      />
    </div>
  )
}

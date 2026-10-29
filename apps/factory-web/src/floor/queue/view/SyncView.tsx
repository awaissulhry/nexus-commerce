'use client'

import { ArrowLeft, Check, CheckCheck, ChevronDown, ChevronUp, CircleCheck, Clock3, CloudOff, CloudUpload, HardDrive, Hash, OctagonAlert, RotateCcw, Send, Trash2, TriangleAlert, Users, X } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import type { EventSummary } from '@nexus/factory-domain/floor-sync/rules'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'
import { whatKeyOf } from '../actions'
import './sync.css'

/**
 * SCR-023 — Waiting to send (design floor.sync; PLT-237, PLT-239, PLT-240, PLT-242): what this tablet holds for the person
 * signed in, in the queue's order, and what became of it. "This tablet now" (big numbers: waiting, refused, recorded
 * today; online or offline and the last send; the clock check; whether the data is kept; label numbers left), "Refused,
 * with a fix" (each with its reason in words and ONE fix; a row opens as a step screen with Discard — with the network;
 * one that may pass later is sent again by itself, or now), "Waiting, in send order" (cannot be edited or deleted here),
 * "Recorded today" (collapsed). Other people's actions are counted, never shown (Statuto dei Lavoratori art. 4). The
 * main action is Send now, bottom right.
 */

export interface SyncRow {
  readonly key: string
  readonly kind: string
  readonly summary: EventSummary
  /** When it was done, by the tablet's clock. */
  readonly at: string
}

export interface RefusedRowModel extends SyncRow {
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly final: boolean
}

export interface SyncViewModel {
  frame: FrameModel
  online: boolean
  sending: boolean
  lastSentAt: string | null
  counts: { waiting: number; refused: number; recordedToday: number; othersWaiting: number; othersRefused: number }
  /** The tablet's clock against the server's (PLT-240), at the last send. */
  clock: { minutes: number; ahead: boolean; flagged: boolean } | null
  storage: 'kept' | 'low' | 'mayClear' | null
  freeMb: number | null
  /** Label numbers left on this tablet, per kind it numbers offline. */
  numbers: readonly { kind: ScanIdKind; left: number; low: boolean }[]
  refused: readonly RefusedRowModel[]
  waiting: readonly (SyncRow & { sending: boolean; again: boolean })[]
  recorded: readonly (SyncRow & { recordedAt: string })[]
  showRecorded: boolean
  /** A refused row open as a step screen. */
  open: string | null
  /** The discard confirm of the open row. */
  confirm: boolean
  /** The last send did not reach the office. */
  problem: 'signedOut' | 'unavailable' | null
}

export type SyncAction =
  | { type: 'send' }
  | { type: 'open'; key: string }
  | { type: 'back' }
  | { type: 'discard' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'recorded'; show: boolean }

export interface SyncViewProps {
  model: SyncViewModel
  onAction?: (action: SyncAction) => void
  onFrame?: (action: FrameAction) => void
}

const KNOWN_REFUSALS = new Set([
  'UNKNOWN_BUNDLE',
  'REPLACED',
  'VOIDED',
  'WORK_ORDER_NOT_OPEN',
  'PREVIOUS_NOT_REPORTED',
  'FLOOR_NOT_READY',
  'NOT_RESERVED',
  'BLOCK_CLOSED',
  'ALREADY_USED',
  'NOT_ALLOWED',
  'BAD_EVENT',
  'UNKNOWN_KIND',
  'CLIENT_ID_REUSED',
  'HIDE_USED_UP',
  'ALREADY_REPORTED',
  'NOT_FOUND',
  'CONFLICT',
])
/** The refusal codes the screen has its own words for (the others show the server's). */
export const REFUSAL_WORDS: readonly string[] = [...KNOWN_REFUSALS]

/** What an action was, in the person's words: "Report BN-… · 18 good · 2 scrap". */
export function useWhat(): (row: Pick<SyncRow, 'kind' | 'summary'>) => string {
  const t = useT('floor')
  return ({ kind, summary }) => {
    const key = whatKeyOf(kind)
    const code = summary.code ?? t('sync.what.noCode')
    // The action's own number picks the plural form: the good garments of a report, the sets of a cut, a bundle's pieces.
    const count = key === 'cut' ? (summary.sets ?? 0) : key === 'bundle' ? (summary.quantity ?? 0) : (summary.good ?? 0)
    const parts = [t(`sync.what.${key}`, { code, count })]
    if (summary.scrap) parts.push(t('sync.what.scrap', { count: summary.scrap }))
    if (summary.rework) parts.push(t('sync.what.rework', { count: summary.rework }))
    return parts.join(' · ')
  }
}

export function SyncView({ model, onAction, onFrame }: SyncViewProps) {
  const t = useT('floor')
  const locale = useLocale()
  const what = useWhat()
  const send = (action: SyncAction) => onAction?.(action)
  const time = (value: string) => formatTime(value, { locale })
  const refusalWords = (row: RefusedRowModel) =>
    KNOWN_REFUSALS.has(row.code) ? { message: t(`sync.refusal.${row.code}.message`), fix: t(`sync.refusal.${row.code}.fix`) } : { message: row.message, fix: row.fix }
  const opened = model.open ? model.refused.find((row) => row.key === model.open) : undefined

  if (opened) {
    const words = refusalWords(opened)
    const back: FloorAction = { label: t('sync.detail.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
    const again: FloorAction = { label: t('sync.detail.again'), icon: <RotateCcw />, onPress: () => send({ type: 'send' }), variant: 'secondary', heldReason: model.online ? null : t('sync.needsNetwork') }
    const discard: FloorAction = { label: t('sync.detail.discard'), icon: <Trash2 />, onPress: () => send({ type: 'discard' }), variant: 'danger', heldReason: model.online ? null : t('sync.needsNetwork') }
    const actions: FloorActions = opened.final ? [back, discard] : [back, again, discard]
    return (
      <FloorFrameView frame={model.frame} onFrame={onFrame} actions={<FloorActionBar label={t('sync.detail.actions')} actions={actions} />}>
        <FloorState tone={opened.final ? 'danger' : 'warning'} icon={<OctagonAlert />} title={what(opened)} text={words.message} alert>
          <p className="fw-floor-lead">
            <strong>{t('sync.detail.fix')}</strong> {words.fix}
          </p>
          <p className="fw-floor-muted">{t('sync.detail.when', { time: time(opened.at) })}</p>
          <p className="fw-floor-muted">{opened.final ? t('sync.detail.final') : t('sync.detail.notFinal')}</p>
          {model.online ? null : <p className="fw-floor-muted">{t('sync.needsNetworkDiscard')}</p>}
        </FloorState>
        <Modal open={model.confirm} onClose={() => send({ type: 'cancel' })} title={t('sync.discard.title')} size="sm" className="fw-floor-dialog">
          <div className="fw-floor-dialog-body">
            <p className="fw-floor-dialog-line">
              <strong>{what(opened)}</strong>
            </p>
            <p className="fw-floor-dialog-line">{t('sync.discard.body')}</p>
            <div className="fw-floor-dialog-actions">
              {/* Enter = Cancel (design sync.discard): the safe action has the focus. */}
              <FloorButton size="lg" variant="secondary" icon={<X />} autoFocus onClick={() => send({ type: 'cancel' })}>
                {t('sync.discard.cancel')}
              </FloorButton>
              <FloorButton size="lg" variant="danger" icon={<Trash2 />} onClick={() => send({ type: 'confirm' })}>
                {t('sync.discard.confirm')}
              </FloorButton>
            </div>
          </div>
        </Modal>
      </FloorFrameView>
    )
  }

  const sendNow: FloorAction = {
    label: model.sending ? t('sync.sending') : t('sync.sendNow'),
    icon: <Send />,
    onPress: () => send({ type: 'send' }),
    variant: 'primary',
    heldReason: !model.online ? t('sync.noNetwork') : model.sending ? t('sync.sending') : null,
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={<FloorActionBar label={t('sync.actions')} actions={[sendNow]} />}>
      <div className="fw-floor-stack">
        <section className="fw-floor-section" aria-labelledby="sync-now">
          <h2 id="sync-now" className="fw-floor-section-title">
            {t('sync.now.title')}
          </h2>
          <div className="fw-floor-sync-counts">
            <FloorList label={t('sync.now.waiting')}>
              <FloorListRow icon={<Clock3 />} tone={model.counts.waiting > 0 ? 'info' : 'neutral'} title={t('sync.now.waiting')} count={model.counts.waiting} />
            </FloorList>
            <FloorList label={t('sync.now.refused')}>
              <FloorListRow icon={<OctagonAlert />} tone={model.counts.refused > 0 ? 'danger' : 'neutral'} title={t('sync.now.refused')} count={model.counts.refused} />
            </FloorList>
            <FloorList label={t('sync.now.recorded')}>
              <FloorListRow icon={<CheckCheck />} tone="success" title={t('sync.now.recorded')} count={model.counts.recordedToday} />
            </FloorList>
          </div>
          <p className="fw-floor-notice" data-tone={model.online ? 'success' : 'warning'} role="status">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              {model.online ? <CloudUpload /> : <CloudOff />}
            </span>
            {model.online ? t('sync.now.online') : t('sync.now.offline')}
            {' · '}
            {model.lastSentAt ? t('sync.now.lastSent', { time: time(model.lastSentAt) }) : t('sync.now.neverSent')}
          </p>
          {model.problem ? (
            <p className="fw-floor-notice" data-tone="warning" role="alert">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <TriangleAlert />
              </span>
              {t(`sync.problem.${model.problem}`)}
            </p>
          ) : null}
          {model.clock ? (
            <p className="fw-floor-notice" data-tone={model.clock.flagged ? 'danger' : 'warning'} role="alert">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Clock3 />
              </span>
              {t(model.clock.ahead ? 'sync.clock.ahead' : 'sync.clock.behind', { count: model.clock.minutes })}
            </p>
          ) : null}
          {model.storage ? (
            <p className="fw-floor-notice" data-tone={model.storage === 'kept' ? 'success' : 'warning'}>
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <HardDrive />
              </span>
              {t(`sync.storage.${model.storage}`, { mb: model.freeMb ?? 0 })}
            </p>
          ) : null}
          {model.numbers.map((entry) => (
            <p key={entry.kind} className="fw-floor-notice" data-tone={entry.low ? 'warning' : 'info'}>
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Hash />
              </span>
              {t(entry.low ? (model.online ? 'sync.numbers.lowOnline' : 'sync.numbers.lowOffline') : 'sync.numbers.left', { count: entry.left, what: t(`sync.numbers.kind.${entry.kind}`) })}
            </p>
          ))}
        </section>

        <section className="fw-floor-section" aria-labelledby="sync-refused">
          <h2 id="sync-refused" className="fw-floor-section-title">
            {t('sync.refused.title')}
          </h2>
          {model.refused.length === 0 ? (
            <p className="fw-floor-notice" data-tone="success">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Check />
              </span>
              {t('sync.refused.empty')}
            </p>
          ) : (
            <FloorList label={t('sync.refused.title')}>
              {model.refused.map((row) => {
                const words = refusalWords(row)
                return (
                  <FloorListRow
                    key={row.key}
                    icon={<OctagonAlert />}
                    tone={row.final ? 'danger' : 'warning'}
                    title={what(row)}
                    meta={`${time(row.at)} · ${words.message} ${words.fix}`}
                    status={row.final ? t('sync.refused.final') : t('sync.refused.again')}
                    onPress={() => send({ type: 'open', key: row.key })}
                  />
                )
              })}
            </FloorList>
          )}
          {model.counts.othersRefused > 0 ? (
            <p className="fw-floor-muted">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Users />
              </span>
              {t('sync.refused.others', { count: model.counts.othersRefused })}
            </p>
          ) : null}
        </section>

        <section className="fw-floor-section" aria-labelledby="sync-waiting">
          <h2 id="sync-waiting" className="fw-floor-section-title">
            {t('sync.waiting.title')}
          </h2>
          {model.waiting.length === 0 ? (
            <p className="fw-floor-notice" data-tone="success">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <CircleCheck />
              </span>
              {t('sync.waiting.empty')}
            </p>
          ) : (
            <>
              {model.online ? null : (
                <p className="fw-floor-notice" data-tone="warning">
                  <span className="fw-floor-inline-icon" aria-hidden="true">
                    <CloudOff />
                  </span>
                  {t('sync.waiting.offline')}
                </p>
              )}
              <FloorList label={t('sync.waiting.title')}>
                {model.waiting.map((row) => (
                  <FloorListRow
                    key={row.key}
                    icon={row.sending ? <CloudUpload /> : <Check />}
                    tone={row.sending ? 'info' : 'neutral'}
                    title={what(row)}
                    meta={time(row.at)}
                    status={row.sending ? t('sync.waiting.sending') : row.again ? t('sync.waiting.again') : t('sync.waiting.saved')}
                  />
                ))}
              </FloorList>
            </>
          )}
          {model.counts.othersWaiting > 0 ? (
            <p className="fw-floor-muted">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Users />
              </span>
              {t('sync.waiting.others', { count: model.counts.othersWaiting })}
            </p>
          ) : null}
        </section>

        <section className="fw-floor-section" aria-labelledby="sync-recorded">
          <h2 id="sync-recorded" className="fw-floor-section-title">
            {t('sync.recorded.title')}
          </h2>
          <div className="fw-floor-row-actions">
            <FloorButton
              size="md"
              variant="secondary"
              icon={model.showRecorded ? <ChevronUp /> : <ChevronDown />}
              aria-expanded={model.showRecorded}
              aria-controls="sync-recorded-list"
              onClick={() => send({ type: 'recorded', show: !model.showRecorded })}
            >
              {model.showRecorded ? t('sync.recorded.hide') : t('sync.recorded.show', { count: model.recorded.length })}
            </FloorButton>
          </div>
          {model.showRecorded ? (
            model.recorded.length === 0 ? (
              <p id="sync-recorded-list" className="fw-floor-muted">
                {t('sync.recorded.empty')}
              </p>
            ) : (
              <div id="sync-recorded-list">
                <FloorList label={t('sync.recorded.title')}>
                  {model.recorded.map((row) => (
                    <FloorListRow key={row.key} icon={<CheckCheck />} tone="success" title={what(row)} meta={t('sync.recorded.at', { device: time(row.at), server: time(row.recordedAt) })} status={t('sync.recorded.status')} />
                  ))}
                </FloorList>
              </div>
            )
          ) : null}
        </section>
      </div>
    </FloorFrameView>
  )
}

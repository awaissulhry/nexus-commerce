'use client'

import { ImagePlus } from 'lucide-react'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button } from '@nexus/ui/primitives'
import { ActionConfirm, FileRow, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { OfflineBanner, Loading, RecordGone } from '../view/parts'
import { PhotosDialog, PhotoViewer, type PhotosActions, type PhotosModel, type PhotoViewerModel } from '../view/Dialogs'
import { useReturnWords } from '../words'
import type { Repair } from './api'
import { garmentLine, LIMITS, moneyText, NS, repairSteps, unitPriceText, type RepairTab } from './model'
import '../returns.css'
import './repair.css'

/**
 * SCR-358 — a customer's repair in the portal (B-W2b-342; SAL-384, SAL-385, SAL-387; RR1:02; design portal.customer.returns
 * rec "Return" › Request / Status, the same tabs for a repair; repair.estimate "Parts and labour, approved by the customer
 * before work starts" · "Customer decision shown with time"). The frame's band holds the title, the stage, "Add photos"
 * while the work has not started and "Answer the estimate" while one waits; this view draws the tab and its pop-ups:
 *
 *   Status   where it is (DS MilestoneTracker: received · estimated · approved · in repair · repaired · sent back), the next
 *            step (yours or ours), where to send the garment while we wait for it, the estimate once sent: its parts and
 *            labour with prices (only with the price grain), its total, its last day, our words, and Accept / Decline
 *            (held with why); an answered one says when and how.
 *   Request  what you asked (the kind, the garment, what is wrong, the work wanted, how and when), your damage photos with
 *            View and Add photos.
 * Pop-ups: Accept (DS ActionConfirm: the amount and that the work starts), Decline (DS Modal: your words, needed), Add
 * photos and a photo full size (B-W2b-197's dialogs). Words of `returns-repair` (and `portal-returns` for the shared
 * dialogs).
 */

export type RepairDialog =
  | { kind: 'accept'; busy: boolean; problem: string | null }
  | { kind: 'decline'; busy: boolean; problem: string | null; reason: string; tried: boolean }
  | { kind: 'photos'; model: PhotosModel }
  | { kind: 'photo'; model: PhotoViewerModel }

export interface RepairRecordViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  repair: Repair | null
  tab: RepairTab
  prefix: string
  offlineSince: string | null
  seesPrices: boolean
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; key: string; params?: Readonly<Record<string, string | number>> } | null
  /** Add photos waits: why (a key of returns-repair), or null. */
  photosHeld: string | null
  /** Accept / Decline wait: why (a key), or null. */
  answerHeld: string | null
  /** A photo cannot open now (offline, a preview): why (words), or null. */
  fileHeld: string | null
  dialog: RepairDialog | null
}

export interface RepairRecordActions {
  onRetry?: () => void
  onPhotos?: () => void
  onPhoto?: (index: number) => void
  onAccept?: () => void
  onDecline?: () => void
  onDismissNotice?: () => void
  dialog?: {
    accept?: { onConfirm?: () => void; onClose?: () => void }
    decline?: { onReason?: (reason: string) => void; onConfirm?: () => void; onClose?: () => void }
    photos?: PhotosActions
    photo?: { onIndex?: (index: number) => void; onClose?: () => void; onRetry?: () => void }
  }
}

export function RepairRecordView({ model, actions }: { model: RepairRecordViewModel; actions?: RepairRecordActions }) {
  const r = useT(NS)
  const listHref = `${model.prefix}/returns`
  if (model.state === 'loading') return <Loading rows={4} height={80} />
  if (model.state === 'missing') return <RecordGone kind="missing" listHref={listHref} />
  if (model.state === 'error' || !model.repair) return <RecordGone kind="error" listHref={listHref} onRetry={actions?.onRetry} />
  const repair = model.repair
  const dialog = model.dialog
  return (
    <div className="fw-pret">
      <OfflineBanner since={model.offlineSince} />
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={r(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {r('portal.notice.hide')}
            </Button>
          }
        />
      ) : null}
      {model.tab === 'status' ? <Status model={model} repair={repair} actions={actions} /> : <Request model={model} repair={repair} actions={actions} />}
      {dialog?.kind === 'accept' ? <AcceptDialog repair={repair} model={model} busy={dialog.busy} problem={dialog.problem} onConfirm={actions?.dialog?.accept?.onConfirm} onClose={actions?.dialog?.accept?.onClose} /> : null}
      {dialog?.kind === 'decline' ? <DeclineDialog repair={repair} dialog={dialog} actions={actions?.dialog?.decline} /> : null}
      {dialog?.kind === 'photos' ? <PhotosDialog model={dialog.model} actions={actions?.dialog?.photos} /> : null}
      {dialog?.kind === 'photo' ? <PhotoViewer model={dialog.model} onIndex={actions?.dialog?.photo?.onIndex} onClose={actions?.dialog?.photo?.onClose} onRetry={actions?.dialog?.photo?.onRetry} /> : null}
    </div>
  )
}

function NextBox({ repair }: { repair: Repair }) {
  const r = useT(NS)
  return (
    <div className={repair.next.forYou ? 'fw-pret-nextbox is-yours' : 'fw-pret-nextbox'}>
      <span className="fw-pret-nextlabel">{repair.next.forYou ? r('portal.next.forYou') : r('portal.next.ours')}</span>
      <p className="fw-pret-strong">{r(`common.next.${repair.next.code}`)}</p>
    </div>
  )
}

// ── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function Status({ model, repair, actions }: { model: RepairRecordViewModel; repair: Repair; actions?: RepairRecordActions }) {
  const r = useT(NS)
  const { at } = useReturnWords()
  const ds = useDsWords()
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-prep-where">
        <h2 id="fw-prep-where" className="fw-pret-h2">
          {r('portal.status.where')}
        </h2>
        <Card padded>
          <MilestoneTracker steps={repairSteps(repair.steps, r, at)} label={r('portal.status.steps', { number: repair.number })} labels={ds.milestoneTracker} />
          <NextBox repair={repair} />
          {repair.sendTo ? (
            <div className="fw-pret-block">
              <h3 className="fw-pret-h3">{r('portal.status.sendTo')}</h3>
              <p>{[repair.sendTo.name, repair.sendTo.address].filter(Boolean).join(', ')}</p>
              <p className="fw-pret-hint">{r('portal.status.sendToHint', { number: repair.number })}</p>
            </div>
          ) : null}
        </Card>
      </section>
      <Estimate model={model} repair={repair} actions={actions} />
    </div>
  )
}

function Estimate({ model, repair, actions }: { model: RepairRecordViewModel; repair: Repair; actions?: RepairRecordActions }) {
  const r = useT(NS)
  const { locale, at, day } = useReturnWords()
  const estimate = repair.estimate
  return (
    <section className="fw-pret-section" aria-labelledby="fw-prep-estimate">
      <h2 id="fw-prep-estimate" className="fw-pret-h2">
        {r('portal.estimate.title')}
      </h2>
      {!estimate ? (
        <p className="fw-pret-quiet">{repair.open ? r('portal.estimate.none') : r('portal.estimate.noneClosed')}</p>
      ) : (
        <Card padded>
          <p className="fw-pret-strong">{r('portal.estimate.revision', { revision: estimate.revision })}</p>
          {!model.seesPrices ? <Banner tone="info" title={r('portal.estimate.noPrices')} /> : null}
          <SummaryTable
            label={r('portal.estimate.lines')}
            columns={[r('portal.estimate.col.what'), r('portal.estimate.col.quantity'), r('portal.estimate.col.minutes'), ...(model.seesPrices ? [r('portal.estimate.col.price'), r('portal.estimate.col.total')] : [])]}
            rows={estimate.lines.map((line) => ({
              id: String(line.seq),
              cells: [
                `${r(`portal.estimate.kind.${line.kind}`)}: ${line.description}`,
                line.quantity,
                line.minutes !== null ? r('portal.estimate.minutesValue', { minutes: line.minutes }) : '—',
                ...(model.seesPrices ? [unitPriceText(line.unitPrice, estimate.currency, locale) ?? '—', moneyText(line.amount, estimate.currency, locale) ?? '—'] : []),
              ],
            }))}
            align={[undefined, 'right', 'right', ...(model.seesPrices ? (['right', 'right'] as const) : [])]}
            stackOnPhone
          />
          <KeyValue
            columns={2}
            items={[
              ...(model.seesPrices ? [{ label: r('portal.estimate.total'), value: <strong>{moneyText(estimate.amount, estimate.currency, locale) ?? '—'}</strong> }] : []),
              { label: r('portal.estimate.labour'), value: r('portal.estimate.minutesValue', { minutes: estimate.labourMinutes }) },
              { label: r('portal.estimate.validUntil'), value: estimate.validUntil ? day(estimate.validUntil) : r('portal.estimate.noEnd') },
              { label: r('portal.estimate.sent'), value: estimate.sentAt ? at(estimate.sentAt) : '—' },
            ]}
          />
          {estimate.customerNote ? (
            <div className="fw-pret-block">
              <h3 className="fw-pret-h3">{r('portal.estimate.ourWords')}</h3>
              <p className="fw-pret-pre">{estimate.customerNote}</p>
            </div>
          ) : null}
          {estimate.status === 'SENT' ? (
            <div className="fw-pret-block">
              <p className="fw-pret-hint">{r('portal.estimate.ask')}</p>
              <div className="fw-prep-actions">
                <Button onClick={() => actions?.onDecline?.()} heldReason={model.answerHeld ? r(model.answerHeld) : null}>
                  {r('portal.estimate.decline')}
                </Button>
                <Button variant="primary" onClick={() => actions?.onAccept?.()} heldReason={model.answerHeld ? r(model.answerHeld) : null}>
                  {r('portal.estimate.accept')}
                </Button>
              </div>
            </div>
          ) : (
            <Banner
              tone={estimate.status === 'ACCEPTED' ? 'success' : 'neutral'}
              title={r(`portal.estimate.answered.${estimate.status === 'ACCEPTED' ? 'ACCEPTED' : 'DECLINED'}`, { at: estimate.answeredAt ? at(estimate.answeredAt) : '—', via: r(`portal.estimate.via.${estimate.answeredVia ?? 'OFFICE'}`) })}
            >
              {estimate.declineReason ? r('portal.estimate.yourReason', { reason: estimate.declineReason }) : null}
            </Banner>
          )}
        </Card>
      )}
    </section>
  )
}

// ── Request ────────────────────────────────────────────────────────────────────────────────────────────────────────
function Request({ model, repair, actions }: { model: RepairRecordViewModel; repair: Repair; actions?: RepairRecordActions }) {
  const r = useT(NS)
  const { at, date } = useReturnWords()
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-prep-what">
        <h2 id="fw-prep-what" className="fw-pret-h2">
          {r('portal.request.what')}
        </h2>
        <Card padded>
          <KeyValue
            columns={2}
            items={[
              { label: r('common.kind.question'), value: r(`common.kind.${repair.kind}`) },
              { label: r('portal.request.opened'), value: at(repair.opened) },
              { label: r('portal.request.via'), value: r(`portal.request.channel.${repair.channel}`) },
              { label: r('portal.request.garment'), value: garmentLine(repair.garment, r) },
            ]}
          />
          <div className="fw-pret-block">
            <h3 className="fw-pret-h3">{r('common.problem')}</h3>
            <p className="fw-pret-pre">{repair.problem}</p>
          </div>
          {repair.workWanted ? (
            <div className="fw-pret-block">
              <h3 className="fw-pret-h3">{r('common.workWanted')}</h3>
              <p className="fw-pret-pre">{repair.workWanted}</p>
            </div>
          ) : null}
        </Card>
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-prep-photos">
        <h2 id="fw-prep-photos" className="fw-pret-h2">
          {r('portal.request.photos')}
          <span className="fw-pret-h2-count">{repair.photos.length}</span>
        </h2>
        <p className="fw-pret-hint">{repair.kind === 'REPAIR' ? r('portal.request.photosHint', { count: 2 }) : r('portal.request.photosHintAlteration')}</p>
        {repair.photos.length === 0 ? <p className="fw-pret-quiet">{r('portal.request.noPhotos')}</p> : null}
        {repair.photos.length > 0 ? (
          <ul className="fw-pret-filelist" aria-label={r('portal.request.photos')}>
            {repair.photos.map((photo, index) => (
              <li key={photo.id}>
                <FileRow
                  name={photo.name}
                  size={photo.sizeBytes}
                  status={r('portal.request.photoAdded', { date: date(photo.at) })}
                  actions={
                    <Button size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onPhoto?.(index)}>
                      {r('portal.request.view')}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button size="sm" heldReason={model.photosHeld ? r(model.photosHeld, { max: LIMITS.photos }) : null} onClick={() => actions?.onPhotos?.()}>
            <ImagePlus size={14} aria-hidden /> {r('portal.request.addPhotos')}
          </Button>
        </div>
      </section>
    </div>
  )
}

// ── the answer's pop-ups ─────────────────────────────────────────────────────────────────────────────────────────────
function AcceptDialog({ repair, model, busy, problem, onConfirm, onClose }: { repair: Repair; model: RepairRecordViewModel; busy: boolean; problem: string | null; onConfirm?: () => void; onClose?: () => void }) {
  const r = useT(NS)
  const { locale } = useReturnWords()
  const estimate = repair.estimate
  const amount = estimate ? moneyText(estimate.amount, estimate.currency, locale) : null
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: r('portal.accept.title', { revision: estimate?.revision ?? 1 }),
        confirmLabel: busy ? r('portal.accept.busy') : r('portal.accept.confirm'),
        consequences: [model.seesPrices && amount ? r('portal.accept.amount', { amount }) : r('portal.accept.what', { number: repair.number }), r('portal.accept.work')],
        reversal: { verb: r('portal.accept.undo'), fidelity: 'lossy' },
        ...(problem ? { refusal: { reason: r(problem) } } : {}),
      }}
      onConfirm={() => onConfirm?.()}
      onCancel={() => (busy ? undefined : onClose?.())}
    />
  )
}

function DeclineDialog({ repair, dialog, actions }: { repair: Repair; dialog: Extract<RepairDialog, { kind: 'decline' }>; actions?: { onReason?: (reason: string) => void; onConfirm?: () => void; onClose?: () => void } }) {
  const r = useT(NS)
  const empty = dialog.reason.trim() === ''
  return (
    <Modal
      open
      onClose={() => (dialog.busy ? undefined : actions?.onClose?.())}
      size="md"
      sheet
      title={r('portal.decline.title', { revision: repair.estimate?.revision ?? 1 })}
      subtitle={repair.number}
      closeHeld={dialog.busy ? r('portal.held.busy') : null}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} heldReason={dialog.busy ? r('portal.held.busy') : null}>
            {r('portal.decline.keep')}
          </Button>
          <Button variant="danger" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? r('portal.held.busy') : empty ? r('portal.decline.needed') : null}>
            {dialog.busy ? r('portal.decline.busy') : r('portal.decline.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-pret-dialog">
        {dialog.problem ? <Banner tone="danger" title={r(dialog.problem)} /> : null}
        <p>{r('portal.decline.what')}</p>
        <Field label={r('portal.decline.reason')} hint={r('portal.decline.reasonHint')} error={dialog.tried && empty ? r('portal.decline.needed') : undefined} required>
          <Textarea className="fw-pret-note" limit={LIMITS.declineReason} value={dialog.reason} data-autofocus onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

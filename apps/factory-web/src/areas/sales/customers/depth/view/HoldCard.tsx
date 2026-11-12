'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea, Timeline } from '../../../../../lib/i18n/ds-parts'
import type { Holds } from '../api'
import { holdDraftProblem, REASONS, toggleHeld, valueOf, writeHeld, type DepthCan, type HoldDialog, type Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

/**
 * Tax & terms › Hold (B-W2b-324; SAL-023; design sales.customers record customer.tax.hold): On hold (the Toggle: on asks
 * the reason and the words; off releases the one hold in force, with words), each hold in force with its reason, company,
 * words, who and when (the system for a credit check) and its own Release, the accepted quotes whose order waits for the
 * release, and the history (released holds, who released them and why). Fetches nothing.
 */

export interface HoldCardModel {
  readonly read: Read<Holds>
  readonly can: DepthCan
  readonly status: string
  readonly prefix: string
  readonly dialog: HoldDialog | null
  readonly companies: readonly { readonly id: string; readonly name: string }[]
}

export interface HoldCardActions {
  onPlace?: () => void
  onRelease?: (hold: Holds['holds'][number]) => void
  onToggle?: (on: boolean) => void
  onDraft?: (dialog: HoldDialog) => void
  onConfirm?: () => void
  onClose?: () => void
  onRetry?: () => void
}

export function HoldCard({ model, actions }: { model: HoldCardModel; actions?: HoldCardActions }) {
  const { t, day, when } = useSay()
  const read = valueOf(model.read)
  const held = writeHeld(model.can, 'hold', model.status)
  const inForce = read?.holds.filter((hold) => hold.inForce) ?? []
  const released = read?.holds.filter((hold) => !hold.inForce) ?? []
  const toggle = read ? toggleHeld(read.holds, held) : held
  return (
    <DepthCard
      title={t('hold.title')}
      hint={t('hold.hint')}
      action={
        <Button size="sm" onClick={() => actions?.onPlace?.()} heldReason={held ? t(held) : null}>
          {t('hold.place')}
        </Button>
      }
    >
      <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('hold.title')} onRetry={actions?.onRetry}>
        {read ? (
          <div className="fw-cdp-stack">
            <div className="fw-cdp-toggle-row">
              <Toggle checked={inForce.length > 0} onChange={(on) => actions?.onToggle?.(on)} disabled={toggle !== null} aria-label={t('hold.toggle')} />
              <span className="fw-cdp-name">{t(inForce.length > 0 ? 'hold.on' : 'hold.off')}</span>
              {toggle ? <span className="fw-cdp-hint">{t(toggle)}</span> : null}
            </div>
            {inForce.length > 0 ? (
              <SummaryTable
                label={t('hold.inForce')}
                stackOnPhone
                density="roomy"
                columns={[t('hold.col.reason'), t('hold.col.company'), t('hold.col.words'), t('hold.col.placed'), '']}
                widths={['16%', '16%', '34%', '22%', '12%']}
                rows={inForce.map((hold) => ({
                  id: hold.id,
                  cells: [
                    <Tag key="r" tone="danger">
                      {t(`reason.${hold.reason}`)}
                    </Tag>,
                    hold.company ? hold.company.name : t('hold.everyCompany'),
                    <span key="w" className="fw-cdp-clip">
                      {hold.words}
                    </span>,
                    hold.placedBy ? t('hold.placedBy', { date: when(hold.placedAt), by: hold.placedBy }) : t('hold.placedSystem', { date: when(hold.placedAt) }),
                    <Button key="a" size="sm" onClick={() => actions?.onRelease?.(hold)} heldReason={held ? t(held) : null}>
                      {t('hold.release')}
                    </Button>,
                  ],
                }))}
              />
            ) : (
              <p className="fw-cdp-hint">{t('hold.none')}</p>
            )}
            {inForce.length > 0 && <Banner tone="warning" title={t('hold.stops')} />}
            {read.ordersWaiting.length > 0 && (
              <div className="fw-cdp-stack">
                <h3 className="fw-cdp-subtitle">{t('hold.waiting', { count: read.ordersWaiting.length })}</h3>
                <ul className="fw-cdp-list">
                  {read.ordersWaiting.map((order) => (
                    <li key={order.quoteVersionId}>
                      <Link className="fw-cdp-code" href={`${model.prefix}/sales/quotes/${encodeURIComponent(order.quoteId)}`}>
                        {t('hold.quoteRev', { number: order.number, revision: order.revision })}
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="fw-cdp-hint">{t('hold.waitingHint')}</p>
              </div>
            )}
            <div className="fw-cdp-stack">
              <h3 className="fw-cdp-subtitle">{t('hold.history')}</h3>
              {released.length === 0 ? (
                <p className="fw-cdp-hint">{t('hold.noHistory')}</p>
              ) : (
                <Timeline
                  label={t('hold.history')}
                  steps={released.map((hold) => ({
                    key: hold.id,
                    tone: 'neutral',
                    at: hold.releasedAt,
                    label: t('hold.releasedLine', { reason: t(`reason.${hold.reason}`), by: hold.releasedBy ?? t('hold.system') }),
                    detail: `${hold.releaseWords ?? ''} · ${t('hold.placedLine', { date: day(hold.placedAt), words: hold.words })}`,
                  }))}
                />
              )}
            </div>
          </div>
        ) : null}
      </ReadOr>
      <HoldDialogView model={model} actions={actions} />
    </DepthCard>
  )
}

function HoldDialogView({ model, actions }: { model: HoldCardModel; actions?: HoldCardActions | undefined }) {
  const { t, say } = useSay()
  const dialog = model.dialog
  if (!dialog) return null
  const problem = holdDraftProblem(dialog.kind === 'place' ? dialog.draft : { words: dialog.draft.words }, dialog.kind)
  const shown = dialog.tried ? problem : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={dialog.kind === 'place' ? t('hold.dialog.place') : t('hold.dialog.release', { reason: t(`reason.${dialog.hold.reason}`) })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : shown ? say(shown) : null}>
            {dialog.kind === 'place' ? t('hold.dialog.confirmPlace') : t('hold.dialog.confirmRelease')}
          </Button>
        </>
      }
    >
      <div className="fw-cdp-stack">
        {dialog.kind === 'place' ? (
          <>
            <Field label={t('hold.dialog.company')} hint={t('hold.dialog.companyHint')}>
              <Select value={dialog.draft.companyId ?? ''} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, companyId: event.target.value === '' ? null : event.target.value } })}>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
                <option value="">{t('hold.everyCompany')}</option>
              </Select>
            </Field>
            <Field label={t('hold.dialog.reason')} required error={dialog.tried && !dialog.draft.reason ? say(problem) : undefined}>
              <Select value={dialog.draft.reason ?? ''} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, reason: event.target.value === '' ? null : (event.target.value as (typeof REASONS)[number]) } })}>
                <option value="">{t('hold.dialog.pick')}</option>
                {REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`reason.${reason}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('hold.dialog.words')} required hint={t('hold.dialog.wordsHint')} error={dialog.tried && dialog.draft.reason && problem ? say(problem) : undefined}>
              <Textarea rows={3} value={dialog.draft.words} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, words: event.target.value } })} />
            </Field>
            <Banner tone="warning" title={t('hold.dialog.stops')} />
          </>
        ) : (
          <>
            <p className="fw-cdp-hint">{dialog.hold.words}</p>
            <Field label={t('hold.dialog.releaseWords')} required hint={t('hold.dialog.releaseHint')} error={shown ? say(shown) : undefined}>
              <Textarea rows={3} value={dialog.draft.words} onChange={(event) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, words: event.target.value } })} />
            </Field>
          </>
        )}
        {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
      </div>
    </Modal>
  )
}

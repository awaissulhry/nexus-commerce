'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { APPROVAL_NOTE_MAX } from '@nexus/factory-domain/product/materials-depth/rules'
import { ReadField } from '../../../library/parts'
import { useDepthWords } from '../words'
import { APPROVAL_TONE, approvalHeld, MATERIAL_APPROVALS, needsNote, noteText, type MaterialApproval, type MaterialDepthActions, type MaterialDepthModel, type MaterialDepthView } from '../depth-model'

const NS = 'products-materials-depth'

/**
 * SCR-048 Compliance › Approval status (B-W2b-238; PRD-035; design material.cp.approval): pending (in development),
 * approved, approved on a condition, blocked — a released BOM can't hold a blocked one. The decision as four RadioCards and
 * why (required for a condition and a block), who decided and when, and what the material reaches now (styles, draft and
 * released revisions, open work orders) with a link to Where used. A block asks once more and says what it does. Apply
 * is held with its reason (nothing changed, why missing, offline, a write running); a person without
 * product.materials.approve reads it as text. It fetches nothing.
 */
export function ApprovalCard({ model, actions, archived, whereUsedHref }: { model: MaterialDepthModel; actions?: MaterialDepthActions; archived: boolean; whereUsedHref: string }) {
  const t = useT(NS)
  const words = useDepthWords()
  const read = model.depth
  if (read.status === 'idle' || read.status === 'loading')
    return (
      <Card header={t('approval.title')} aria-busy="true">
        <div className="fw-lib-stack" role="status" aria-label={t('loading')}>
          <Skeleton width="60%" height={18} />
          <Skeleton width="100%" height={56} />
          <Skeleton width="40%" height={18} />
        </div>
      </Card>
    )
  if (read.status === 'error')
    return (
      <Card header={t('approval.title')}>
        <Banner tone="danger" title={t('approval.failed')} action={<Button size="sm" onClick={() => actions?.onRetryDepth?.()}>{t('retry')}</Button>}>
          {words(read.problem)}
        </Banner>
      </Card>
    )
  return <Ready depth={read.value} model={model} actions={actions} archived={archived} whereUsedHref={whereUsedHref} />
}

function Ready({ depth, model, actions, archived, whereUsedHref }: { depth: MaterialDepthView; model: MaterialDepthModel; actions?: MaterialDepthActions; archived: boolean; whereUsedHref: string }) {
  const t = useT(NS)
  const words = useDepthWords()
  const locale = useLocale()
  const current = depth.approval
  const base = { approval: current.approval, note: current.note ?? '' }
  const [draft, setDraft] = useState<{ approval: MaterialApproval; note: string }>(model.approvalDraft ?? base)
  const [confirm, setConfirm] = useState(model.confirmBlock ?? false)
  const editable = model.can.approve && !archived
  const held = approvalHeld({ approval: current.approval, note: current.note }, draft, model)
  const decided = current.decidedAt ? t('approval.decided', { name: current.decidedBy?.name ?? t('approval.byRelease'), time: formatDateTime(current.decidedAt, { locale }) }) : t('approval.notDecided')
  const apply = () => {
    if (held) return
    if (draft.approval === 'BLOCKED' && current.approval !== 'BLOCKED') {
      setConfirm(true)
      return
    }
    void actions?.onDecide?.(draft.approval, noteText(draft.note))
  }
  const notice = model.notice
  const refusedNote = model.refused?.paths.some((path) => path === 'note') ? t('approval.noteRefused') : undefined

  return (
    <Card
      header={
        <span className="fw-lib-inline">
          {t('approval.title')} <Pill tone={APPROVAL_TONE[current.approval]}>{t(`approval.state.${current.approval}`)}</Pill>
        </span>
      }
      description={archived ? t('approval.readOnlyArchived') : editable ? t('approval.intro') : t('approval.viewOnly')}
    >
      <div className="fw-lib-stack">
        {notice && (
          <Banner tone={notice.tone} title={words(notice.key, notice.params ? { ...notice.params, approval: t(`approval.state.${String(notice.params.approval ?? '')}`) } : undefined)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{t('dismiss')}</Button>}>
            {model.refused && model.refused.messages.length > 0 && notice.tone === 'danger' ? (
              <ul className="fw-lib-list">
                {model.refused.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        )}
        <KeyValue
          items={[
            { label: t('approval.decidedLabel'), value: decided },
            ...(current.note ? [{ label: t(current.approval === 'BLOCKED' ? 'approval.whyLabel' : current.approval === 'CONDITIONAL' ? 'approval.conditionLabel' : 'approval.noteLabel'), value: current.note }] : []),
          ]}
        />
        <Reach depth={depth} model={model} whereUsedHref={whereUsedHref} />
        {editable ? (
          <>
            <div className="fw-lib-form-grid" role="radiogroup" aria-label={t('approval.pick')}>
              {MATERIAL_APPROVALS.map((approval) => (
                <RadioCard
                  key={approval}
                  name={`approval-${depth.material.id}`}
                  value={approval}
                  checked={draft.approval === approval}
                  selected={draft.approval === approval}
                  onChange={() => setDraft({ approval, note: approval === current.approval ? (current.note ?? '') : '' })}
                  title={t(`approval.state.${approval}`)}
                  description={t(`approval.means.${approval}`)}
                />
              ))}
            </div>
            <Field
              label={t(draft.approval === 'BLOCKED' ? 'approval.whyLabel' : draft.approval === 'CONDITIONAL' ? 'approval.conditionLabel' : 'approval.noteLabel')}
              required={needsNote(draft.approval)}
              hint={t(needsNote(draft.approval) ? 'approval.noteHintRequired' : 'approval.noteHint')}
              error={refusedNote}
            >
              <Input value={draft.note} maxLength={APPROVAL_NOTE_MAX} onChange={(event) => setDraft((now) => ({ ...now, note: event.target.value }))} />
            </Field>
            <div className="fw-lib-actions">
              <Button size="sm" variant="quiet" heldReason={held === 'approval.held.unchanged' ? t(held) : null} onClick={() => setDraft(base)}>
                {t('discard')}
              </Button>
              <Button size="sm" variant={draft.approval === 'BLOCKED' ? 'danger' : 'primary'} heldReason={held ? t(held) : null} onClick={apply}>
                {t(draft.approval === 'BLOCKED' ? 'approval.applyBlock' : 'approval.apply')}
              </Button>
            </div>
          </>
        ) : (
          <div className="fw-lib-form-grid">
            <ReadField label={t('approval.stateLabel')} value={t(`approval.state.${current.approval}`)} hint={t(`approval.means.${current.approval}`)} />
          </div>
        )}
      </div>
      {confirm && (
        <BlockDialog
          depth={depth}
          busy={model.busy}
          onClose={() => setConfirm(false)}
          onBlock={() => {
            void actions?.onDecide?.('BLOCKED', noteText(draft.note)).then((done) => done && setConfirm(false))
          }}
        />
      )}
    </Card>
  )
}

/** What the material reaches now: the styles, the draft and released revisions naming it, the open work orders. */
function Reach({ depth, model, whereUsedHref }: { depth: MaterialDepthView; model: MaterialDepthModel; whereUsedHref: string }) {
  const t = useT(NS)
  const reach = depth.reach
  if (!model.can.styles) return <p className="fw-lib-hint">{t('approval.reach.noStyles')}</p>
  if (reach.draftRevisions + reach.releasedRevisions === 0) return <p className="fw-lib-hint">{t('approval.reach.none')}</p>
  return (
    <p className="fw-lib-hint">
      {t('approval.reach.words', { styles: reach.styles, drafts: reach.draftRevisions, released: reach.releasedRevisions })}{' '}
      {reach.openWorkOrders === null ? t('approval.reach.noWorkOrders') : t('approval.reach.workOrders', { count: reach.openWorkOrders })}{' '}
      <Link className="fw-lib-link" href={whereUsedHref}>
        {t('approval.reach.open')}
      </Link>
    </p>
  )
}

/** Block: what it does, before it does it (no new BOM line, draft revisions held at release, released ones kept). */
function BlockDialog({ depth, busy, onClose, onBlock }: { depth: MaterialDepthView; busy: boolean; onClose: () => void; onBlock: () => void }) {
  const t = useT(NS)
  const reach = depth.reach
  return (
    <Modal
      open
      onClose={onClose}
      title={t('approval.block.title', { code: depth.material.code })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('back')}</Button>
          <Button variant="danger" heldReason={busy ? t('wait.busy') : null} onClick={onBlock}>
            {t('approval.applyBlock')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('approval.block.noLine')}</li>
          {reach.draftRevisions > 0 && <li>{t('approval.block.drafts', { count: reach.draftRevisions })}</li>}
          {reach.releasedRevisions > 0 && <li>{t('approval.block.released', { count: reach.releasedRevisions })}</li>}
          {reach.openWorkOrders !== null && reach.openWorkOrders > 0 && <li>{t('approval.block.workOrders', { count: reach.openWorkOrders })}</li>}
          <li>{t('approval.block.back')}</li>
        </ul>
      </div>
    </Modal>
  )
}

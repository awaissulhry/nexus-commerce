'use client'

import { X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useT } from '../../../../lib/i18n/provider'
import { pct, reasonHeld, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'

/**
 * The page's dialogs: Change cutting loss for style X (design pop:accept-loss, a confirm: from → to, the cuts it rests on, what
 * it affects — the next plan run and new quotes, never a released order — and where it goes: the draft revision, or nowhere
 * yet), Dismiss with a reason (3 to 500 characters, said before the click), and the keyboard keys.
 */
export function LeatherDialogs({ model, actions, words }: { model: LeatherModel; actions?: LeatherActions; words: Words }) {
  const { t } = words
  const lists = useT('lists')
  const dialog = model.dialog
  if (!dialog) return null
  const yields = model.yields.status === 'ready' ? model.yields.value.rows : []
  if (dialog.kind === 'accept') {
    const row = yields.find((entry) => entry.style.id === dialog.styleId)
    if (!row) return null
    const to = pct(row.proposal.toPct, words)
    const where = row.draft
      ? t('accept.intoDraft', { revision: row.draft.revision, released: row.revision?.revision ?? '—' })
      : t('accept.noDraft', { style: row.style.code, next: (row.revision?.revision ?? 0) + 1 })
    return (
      <ActionConfirm
        impact={{
          level: 'confirm',
          reach: 'local',
          title: t('accept.title', { style: row.style.code }),
          confirmLabel: t('accept.confirm', { to }),
          consequences: [
            t('accept.fromTo', { from: row.proposal.fromPct === null ? '—' : pct(row.proposal.fromPct, words), to, count: row.proposal.cuts }),
            t('accept.affects'),
            where,
          ],
          reversal: { verb: t('accept.back'), fidelity: 'exact' },
          ...(dialog.problem ? { refusal: { reason: t(dialog.problem) } } : {}),
        }}
        onConfirm={() => actions?.onAcceptConfirm?.()}
        onCancel={() => actions?.onCloseDialog?.()}
      />
    )
  }
  if (dialog.kind === 'dismiss') {
    const row = yields.find((entry) => entry.style.id === dialog.styleId)
    const problem = reasonHeld(dialog.reason)
    const held = dialog.busy ? t('held.busy') : problem ? t(problem) : null
    return (
      <Modal
        open
        onClose={() => actions?.onCloseDialog?.()}
        title={t('dismiss.title', { style: row?.style.code ?? '' })}
        subtitle={row ? t('dismiss.subtitle', { from: row.proposal.fromPct === null ? '—' : pct(row.proposal.fromPct, words), to: pct(row.proposal.toPct, words), count: row.proposal.cuts }) : undefined}
        size="md"
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDismissConfirm?.()}>
              {dialog.busy ? <Spinner size={12} /> : <X size={13} aria-hidden />} {t('dismiss.confirm')}
            </Button>
          </>
        }
      >
        <div className="fw-lp-drawer">
          <p className="fw-lp-hint">{t('dismiss.body')}</p>
          <Field label={t('dismiss.reason')} required hint={t('dismiss.reasonHint')}>
            <Textarea rows={3} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDismissReason?.(event.target.value)} />
          </Field>
          {dialog.problem && !dialog.problem.startsWith('held.') && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }
  const keys: ListKey[] = [
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['b'], does: t('keys.draftPo') },
    { keys: ['J', 'K'], does: t('keys.nextOrder') },
  ]
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('page.keys')} size="sm">
      <ul className="fw-lp-list">
        {listKeys(keys, true).map((entry) => (
          <li key={entry.does}>
            <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

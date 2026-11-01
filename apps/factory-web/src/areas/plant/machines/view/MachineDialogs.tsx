'use client'

import { Archive, Plus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Machine } from '../../_shared/api'
import { say, useWords, type Translate } from '../../_shared/parts'
import type { MachinesListActions, MachinesListModel } from '../view-model'
import { MachineFields, machineDraftHeld } from './MachineFields'

/**
 * The register's dialogs (design plant.machines): New machine (`c`, `?new=1`: the site, the asset number on its tag, the
 * type, make, model, serial, year, station and work centre; the supplier and the cost with their rights; after it is
 * made: "Print its tag") and Retire machine (design pop:retire, an ActionConfirm: the reach — its plans end, it is kept for
 * its history, its tag stops offering "Report a problem" — and a reason; refused one by one while a request or job of a
 * machine is open). Composed from the DS Modal: the DS ActionConfirm speaks English only.
 */
export function MachineDialogs({ model, actions }: { model: MachinesListModel; actions?: MachinesListActions }) {
  const t = useWords()
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'new') {
    const heldKey = machineDraftHeld(dialog.draft, true, model.can)
    const held = heldKey ? t(heldKey) : dialog.busy ? t('held.busy') : null
    const submit = () => !held && actions?.onSubmitDialog?.()
    return (
      <Modal
        open
        onClose={() => actions?.onDialogClose?.()}
        title={t('newMachine.title')}
        size="lg"
        footer={
          <>
            <span className="fw-pl-hint">{t('newMachine.foot')}</span>
            <span className="fw-pl-grow" />
            <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
              {dialog.busy ? <Spinner size={12} /> : <Plus size={14} aria-hidden />} {t('newMachine.create')}
            </Button>
          </>
        }
      >
        <form
          className="fw-pl-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        >
          {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
          <MachineFields draft={dialog.draft} creating sites={model.sites} classes={model.classes} suppliers={dialog.suppliers} field={dialog.field} can={model.can} onDraft={actions?.onDraft} onFindSupplier={actions?.onFindSupplier} />
        </form>
      </Modal>
    )
  }
  return <RetireDialog machines={dialog.machines} reason={dialog.reason} busy={dialog.busy} problem={dialog.problem} refused={dialog.refused} t={t} onReason={actions?.onRetireReason} onClose={actions?.onDialogClose} onSubmit={actions?.onSubmitDialog} />
}

/** Retire machine(s): the reach and the reason (a machine with open work is refused in words, one by one). */
export function RetireDialog({
  machines,
  reason,
  busy,
  problem,
  refused,
  t,
  onReason,
  onClose,
  onSubmit,
}: {
  machines: readonly Machine[]
  reason: string
  busy: boolean
  problem: { key: string; params?: Readonly<Record<string, string | number>> } | null
  refused: readonly { assetNumber: string; words: { key: string; params?: Readonly<Record<string, string | number>> } }[]
  t: Translate
  onReason?: (reason: string) => void
  onClose?: () => void
  onSubmit?: () => void
}) {
  const open = machines.filter((machine) => machine.openJobs > 0 || machine.openRequests > 0)
  const held = reason.trim().length === 0 ? t('held.reasonNeeded') : busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={machines.length === 1 ? t('retire.titleOne', { machine: machines[0]!.assetNumber }) : t('retire.titleMany', { count: machines.length })}
      size="md"
      footer={
        <>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => onClose?.()}>
            {t('common.back')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => !held && onSubmit?.()}>
            {busy ? <Spinner size={12} /> : <Archive size={14} aria-hidden />} {t('retire.submit', { count: machines.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        {problem && <Banner tone="danger" title={say(t, problem) ?? ''} />}
        {refused.length > 0 && (
          <Banner tone="warning" title={t('retire.refusedTitle', { count: refused.length })}>
            <ul className="fw-pl-list">
              {refused.map((entry) => (
                <li key={entry.assetNumber}>
                  <span className="fw-pl-code">{entry.assetNumber}</span> — {say(t, entry.words)}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <p className="fw-pl-h3">{t('retire.reach')}</p>
        <ul className="fw-pl-list">
          <li>{t('retire.reachPlans')}</li>
          <li>{t('retire.reachHistory')}</li>
          <li>{t('retire.reachTag')}</li>
        </ul>
        <p className="fw-pl-hint">{t('retire.reversal')}</p>
        {machines.length > 1 && <p className="fw-pl-text">{machines.map((machine) => machine.assetNumber).join(', ')}</p>}
        {open.length > 0 && <p className="fw-pl-hint fw-pl-warning">{t('retire.openWork', { machines: open.map((machine) => machine.assetNumber).join(', ') })}</p>}
        <Field label={t('retire.reason')} required>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => onReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

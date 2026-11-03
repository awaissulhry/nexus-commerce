'use client'

import { ShieldCheck } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, RadioCard, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { SAFE_AFTER } from '../../_shared/api'
import type { Words } from '../../_shared/model'
import { say, useWords } from '../../_shared/parts'
import type { SignSafeDraft } from '../view-model'

/**
 * Sign safe (Owner answer H1; D.Lgs. 81/2008 art. 71): a technician says what was checked and the machine's state after;
 * the office then gives a fresh two-factor code (the container's step-up). The ONE sign-safe dialog of the office: the
 * request's detail (S) and the job's Unsafe lock panel (B-W2b-140) open it.
 */
export function SignSafeDialog({ machine, draft, held, busy, problem, onDraft, onSubmit, onClose }: { machine: string; draft: SignSafeDraft; held: string | null; busy: boolean; problem: Words | null; onDraft?: (patch: Partial<SignSafeDraft>) => void; onSubmit?: () => void; onClose?: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const submit = () => !held && onSubmit?.()
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('signSafe.title', { machine })}
      size="md"
      footer={
        <>
          <span className="fw-pl-hint">{t('signSafe.hint')}</span>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {busy ? <Spinner size={12} /> : <ShieldCheck size={14} aria-hidden />} {t('signSafe.submit')}
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
        {problem && <Banner tone="danger" title={say(t, problem) ?? ''} />}
        <p className="fw-pl-text">{t('signSafe.body')}</p>
        <Field label={t('signSafe.checked')} required hint={t('signSafe.checkedHint')}>
          <Textarea value={draft.note} rows={3} maxLength={500} onChange={(event) => onDraft?.({ note: event.target.value })} />
        </Field>
        <div className="fw-pl-choices" role="radiogroup" aria-label={t('signSafe.after')}>
          <RadioCard name="safe-after" value="" checked={draft.machineAfter === null} selected={draft.machineAfter === null} onChange={() => onDraft?.({ machineAfter: null })} title={t('signSafe.afterAuto')} description={t('signSafe.afterAutoHint')} />
          {SAFE_AFTER.map((after) => (
            <RadioCard key={after} name="safe-after" value={after} checked={draft.machineAfter === after} selected={draft.machineAfter === after} onChange={() => onDraft?.({ machineAfter: after })} title={t(`machineStatus.${after}`)} description={t(`signSafe.afterHint.${after}`)} />
          ))}
        </div>
        <p className="fw-pl-row">
          <LawRef law="D.Lgs. 81/2008 art. 71" plain={t('lockAsUnsafe.lawPlain')} labels={ds.lawRef} />
          <span className="fw-pl-hint">{t('signSafe.law')}</span>
        </p>
      </form>
    </Modal>
  )
}

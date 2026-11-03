'use client'

import { Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { Words } from '../../_shared/model'
import type { Loaded } from '../../_shared/parts'
import { say, useWords } from '../../_shared/parts'
import type { DeepJob, DeepJobRecord } from '../../requests/depth/api'
import type { CloseDraft } from '../../requests/depth/model'
import { CloseForm } from './CloseForm'

/**
 * Hand back (B-W2b-140; design plant.jobs pop:close, opened by a drop on the board's Hand-back lane and by the record's
 * primary): the one-screen close in a dialog. Three taps on the usual path — what was done, the failure code, Hand back
 * (Running is chosen unless the lock holds it). The job's record is read when it opens (the minutes so far, whether the
 * lock holds Running); while it reads the form waits, a failed read says so.
 */
export function HandBackDialog({ number, loaded, draft, held, busy, problem, onDraft, onSubmit, onClose, onRetry }: { number: string; loaded: Loaded<Pick<DeepJobRecord, 'job' | 'close'>>; draft: CloseDraft; held: string | null; busy: boolean; problem: Words | null; onDraft?: (patch: Partial<CloseDraft>) => void; onSubmit?: () => void; onClose?: () => void; onRetry?: () => void }) {
  const t = useWords()
  const value = loaded.status === 'ready' ? loaded.value : null
  const job: DeepJob | null = value?.job ?? null
  const submit = () => !held && onSubmit?.()
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('close.dialogTitle', { number, machine: job?.machine.assetNumber ?? '—' })}
      size="lg"
      footer={
        <>
          <span className="fw-pl-hint">{t('close.dialogHint')}</span>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {busy ? <Spinner size={12} /> : <Undo2 size={14} aria-hidden />} {t('move.handBack')}
          </Button>
        </>
      }
    >
      <div
        className="fw-pl-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {problem && <Banner tone="danger" title={say(t, problem) ?? ''} />}
        {loaded.status === 'loading' && (
          <p className="fw-pl-hint" role="status">
            <Spinner size={12} /> {t('record.loading')}
          </p>
        )}
        {loaded.status === 'error' && (
          <Banner
            tone="danger"
            title={t('record.failed')}
            action={
              <Button size="sm" onClick={() => onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(loaded.problem)}
          </Banner>
        )}
        {(loaded.status === 'notFound' || loaded.status === 'forbidden') && <Banner tone="danger" title={t(loaded.status === 'forbidden' ? 'problem.forbidden' : 'record.notFound')} />}
        {job && value && (
          <>
            {job.machine.locked && <Banner tone="warning" title={t('close.lockedNote', { machine: job.machine.assetNumber })} />}
            <CloseForm job={job} close={value.close} draft={draft} disabled={busy} onDraft={onDraft} />
          </>
        )}
      </div>
    </Modal>
  )
}

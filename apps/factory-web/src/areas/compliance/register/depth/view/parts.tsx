'use client'

import { useEffect, type ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { Modal, StepUpModal, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useScopedT, useT } from '../../../../../lib/i18n/provider'
import type { StepUpState } from '../../../../quality/_shared/hooks'
import type { AuthorityNotice, AuthorityRequest, DistributorNotice, RecallRow } from '../api'
import { DISTRIBUTOR_TONE, DUE_TONE, NOTICE_TONE, RECALL_TONE } from '../model'
import '../depth.css'

/**
 * The register in depth's small parts (B-W2b-271): the state words of a notice, a recall, a distributor notice and a
 * request (a word, never colour alone), the law chip (DS LawRef with its plain words), the dialog frame every action of
 * the depth uses (our title, the API's problem lines under it, ⌘↵, the confirm held with its reason), and the step-up
 * dialog with what the fresh code allows. Words: `compliance-register-depth`.
 */

export const NS = 'compliance-register-depth'

export function NoticeStatus({ notice }: { notice: Pick<AuthorityNotice, 'status'> }) {
  const d = useT(NS)
  return (
    <Pill tone={NOTICE_TONE[notice.status]} dot>
      {d(`noticeStatus.${notice.status}`)}
    </Pill>
  )
}

export function RecallStatus({ recall }: { recall: Pick<RecallRow, 'status'> }) {
  const d = useT(NS)
  return (
    <Pill tone={RECALL_TONE[recall.status]} dot>
      {d(`recallStatus.${recall.status}`)}
    </Pill>
  )
}

export function DistributorStatus({ notice }: { notice: Pick<DistributorNotice, 'status'> }) {
  const d = useT(NS)
  return (
    <Pill tone={DISTRIBUTOR_TONE[notice.status]} dot>
      {d(`distributorStatus.${notice.status}`)}
    </Pill>
  )
}

export function DueWord({ request }: { request: Pick<AuthorityRequest, 'due'> }) {
  const d = useT(NS)
  const { state, daysLeft } = request.due
  const words = state === 'DUE_SOON' || state === 'OPEN' ? d(`due.${state}`, { count: daysLeft ?? 0 }) : state === 'OVERDUE' ? d('due.OVERDUE', { count: Math.abs(daysLeft ?? 0) }) : d(`due.${state}`)
  return (
    <Pill tone={DUE_TONE[state]} dot>
      {words}
    </Pill>
  )
}

/** The law a part rests on, with its plain words (`law.<key>`). */
export function Law({ law, plain }: { law: string; plain: string }) {
  const ds = useDsWords()
  return <LawRef law={law} plain={plain} labels={ds.lawRef} />
}

/** A refusal or a problem inside a dialog: a message key (scoped) with the API's lines under it. */
export interface DialogProblem {
  readonly key: string
  readonly lines: readonly string[]
}

export function ProblemBanner({ problem }: { problem: DialogProblem | null | undefined }) {
  const s = useScopedT(NS)
  if (!problem) return null
  return (
    <Banner tone="danger" title={s(problem.key)}>
      {problem.lines.length > 0 && (
        <ul className="fw-q-lines">
          {problem.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** One action of the depth as a dialog: explicit (never autosaved), ⌘↵ confirms when allowed, Esc closes. */
export function DepthDialog({
  open,
  title,
  sub,
  confirm,
  held,
  busy,
  problem,
  tone = 'primary',
  size = 'md',
  onConfirm,
  onClose,
  children,
  extra,
}: {
  open: boolean
  title: string
  sub?: string
  confirm: string
  held: string | null
  busy: boolean
  problem?: DialogProblem | null
  tone?: 'primary' | 'danger'
  size?: 'sm' | 'md' | 'lg' | 'xl'
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
  /** Beside Cancel, before the confirm (a second action of the same dialog). */
  extra?: ReactNode
}) {
  const d = useT(NS)
  const q = useT('quality')
  const holding = held ?? (busy ? d('dialog.saving') : null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !holding) {
        event.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, holding, onConfirm])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={sub}
      size={size}
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          {extra}
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} heldReason={holding} onClick={onConfirm}>
            {busy ? <Spinner size={14} /> : null} {confirm}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <ProblemBanner problem={problem} />
        {children}
      </div>
    </Modal>
  )
}

/** The DS step-up dialog with what this code allows (`stepUp.<sentence>`) and a refused code in words. */
export function DepthStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void }) {
  const d = useT(NS)
  const q = useT('quality')
  return (
    <StepUpModal
      open={state.open}
      title={d('stepUp.title')}
      sentence={state.sentence ? d(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={d('stepUp.confirm')}
    />
  )
}

/** "3 of 5 told" with the word for none. */
export function ToldText({ told, of }: { told: number; of: number }) {
  const d = useT(NS)
  return <>{of === 0 ? d('told.nobody') : d('told.count', { told, of })}</>
}

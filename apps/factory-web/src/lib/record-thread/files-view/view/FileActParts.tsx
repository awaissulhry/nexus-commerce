'use client'

import type { ReactNode } from 'react'
import { Lock, Mail } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import type { FileActWindow, FileActsState } from '../model'

/** F-OF-303: the doors every file window shares (the container's: use-file-acts). */
export interface FileActActions {
  readonly onActChange?: (next: FileActWindow) => void
  readonly onActFile?: (files: readonly File[]) => void
  readonly onActSubmit?: () => void
  readonly onActClose?: () => void
}

/** A window's footer: Cancel and the act, held with its words (≤ 2 buttons). */
export function ActFoot({ held, busy, label, icon, danger, onCancel, onGo, cancel }: { held: string | null; busy: boolean; label: string; icon?: ReactNode; danger?: boolean; onCancel: () => void; onGo: () => void; cancel?: string }) {
  const t = useT('record-thread-files-view')
  return (
    <>
      <Button onClick={onCancel}>{cancel ?? t('upload.cancel')}</Button>
      <Button variant={danger ? 'danger' : 'primary'} heldReason={busy ? t('acts.held.busy') : held ? t(held) : null} onClick={onGo}>
        {icon} {label}
      </Button>
    </>
  )
}

/** What happens · the customer · what never changes (every file window says them), and the window's refusal. */
export function ActLines({ problem, happens, customer, never }: { problem: FileActsState['problem']; happens: string; customer: string; never: string }) {
  const t = useT('record-thread-files-view')
  return (
    <>
      {problem && (
        <p className="fw-of-act-problem" role="alert">
          {t(problem.key, problem.params)}
        </p>
      )}
      <div className="fw-of-act-lines">
        <p>
          <b>{t('acts.happens')}.</b> {happens}
        </p>
        <p>
          <Mail size={13} aria-hidden /> {customer}
        </p>
        <p className="fw-of-act-never">
          <Lock size={13} aria-hidden /> {never}
        </p>
      </div>
    </>
  )
}

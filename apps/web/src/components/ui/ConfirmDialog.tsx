'use client'

/**
 * U.2 — ConfirmDialog primitive.
 *
 * Replaces 31 `confirm()` / `window.confirm()` calls across the app
 * with a focus-trapped modal that respects the design system. Built
 * on Modal so it inherits the focus-trap, ESC-to-close, and backdrop
 * dismissal behaviour.
 *
 * Imperative API via the useConfirm() hook (next file in this PR
 * companion in U.3 toast adoption) lets call sites swap out
 * `if (confirm('Delete?'))` with `if (await confirmDestructive(...))`.
 *
 * For now, this primitive ships the controlled form. U.3 wires the
 * imperative hook + replaces the 31 confirm() sites + 58 alert()
 * sites in one consolidated commit.
 *
 * Usage (controlled):
 *
 *   const [open, setOpen] = useState(false)
 *   <ConfirmDialog
 *     open={open}
 *     title="Delete view?"
 *     description={`"${name}" will be removed permanently.`}
 *     confirmLabel="Delete"
 *     tone="danger"
 *     onConfirm={() => doDelete()}
 *     onClose={() => setOpen(false)}
 *   />
 */

import { useCallback, useEffect, useRef } from 'react'
import { AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from './Modal'
import { Button } from './Button'
import { cn } from '@/lib/utils'

type Tone = 'danger' | 'warning' | 'info'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: Tone
  onConfirm: () => void | Promise<void>
  onClose: () => void
  /** When true, the confirm button shows a spinner + is disabled.
   *  Useful for async actions that the parent awaits. */
  busy?: boolean
}

const TONE_ICON: Record<Tone, typeof AlertTriangle> = {
  danger: AlertTriangle,
  warning: AlertCircle,
  info: Info,
}

const TONE_ICON_COLOR: Record<Tone, string> = {
  danger:  'text-danger-600 bg-danger-50 border-danger-200',
  warning: 'text-warning-700 bg-warning-50 border-warning-200',
  info:    'text-info-600 bg-info-50 border-info-200',
}

const TONE_BUTTON: Record<Tone, 'danger' | 'primary' | 'secondary'> = {
  danger:  'danger',
  warning: 'primary',
  info:    'primary',
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onClose,
  busy = false,
}: ConfirmDialogProps) {
  const Icon = TONE_ICON[tone]
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // Focus the cancel button on open — safer default than focusing
  // the destructive action so accidental Enter doesn't delete.
  useEffect(() => {
    if (open) {
      // Defer one tick so Modal has mounted + applied focus trap.
      const t = setTimeout(() => cancelRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleConfirm = useCallback(async () => {
    await onConfirm()
  }, [onConfirm])

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      description={description}
      size="sm"
      placement="centered"
      dismissOnBackdrop={!busy}
      dismissOnEscape={!busy}
    >
      <ModalBody>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'inline-flex items-center justify-center w-10 h-10 rounded-full border flex-shrink-0',
              TONE_ICON_COLOR[tone],
            )}
            aria-hidden="true"
          >
            <Icon className="w-5 h-5" />
          </span>
          <div className="text-md text-slate-700">
            {description ?? 'Are you sure?'}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          ref={cancelRef}
          variant="secondary"
          onClick={onClose}
          disabled={busy}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={TONE_BUTTON[tone]}
          onClick={handleConfirm}
          loading={busy}
        >
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

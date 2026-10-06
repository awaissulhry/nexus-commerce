'use client'
/**
 * StepUpModal — the one question before a person RAISES something: a fresh 6-digit code from their authenticator app.
 * Raising never happens without it; lowering never asks for it (a brake is easy).
 *
 * Promoted from Settings › AI › Claude (MCP full control C9) when a third screen needed it (ads autonomy W1-4,
 * 2026-10-06): Claude's levels and limits there, the Approvals page's "Automate this kind…" and its code box for a
 * request that raises, and the Control Room's Strategy tab. One dialog, so a code is asked for the same way everywhere.
 *
 * The API checks the code once (lib/auth/step-up.ts) and the permission (settings.security.manage); this dialog only
 * collects it and shows the API's answer (`error`), with the field focused for the next try. Six digits enable Confirm;
 * Enter submits; Escape cancels.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Banner } from '../components/Banner'
import { Field } from '../components/Field'
import { Modal } from '../components/Modal'
import { Button } from '../primitives/Button'
import { Input } from '../primitives/Input'

export interface StepUpModalProps {
  open: boolean
  title: string
  /** What the code allows, in one sentence. */
  sentence: string
  busy: boolean
  error: string | null
  onSubmit: (code: string) => void
  onClose: () => void
  /** The confirm button's words ("Confirm" when absent): say what happens — "Approve", "Save 3 changes". */
  confirmLabel?: string
  /** Passed to the Modal: a light-pinned surface passes its portal class (the fleet's `fleet-portal`). */
  className?: string
}

export function StepUpModal({ open, title, sentence, busy, error, onSubmit, onClose, confirmLabel = 'Confirm', className }: StepUpModalProps) {
  const [code, setCode] = useState('')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) setCode('')
  }, [open])
  // A refused code comes back with the field ready for the next one: the input is disabled while it is checked, which
  // drops the focus, so it is given back (and the wrong code selected) once the answer is in.
  useEffect(() => {
    if (open && !busy && error) {
      input.current?.focus()
      input.current?.select()
    }
  }, [open, busy, error])
  const ready = !busy && /^\d{6}$/.test(code)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      className={className}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => ready && onSubmit(code)}>
            {busy ? 'Checking…' : confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="nds-stepup"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) onSubmit(code)
        }}
      >
        <p className="nds-stepup-note">{sentence}</p>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Two-factor code" required hint="The 6-digit code from your authenticator app." htmlFor={id}>
          <Input
            ref={input}
            id={id}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={busy}
          />
        </Field>
      </form>
    </Modal>
  )
}

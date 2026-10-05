'use client'
/**
 * MCP full control C9 — the one question before Claude may do MORE without a person: a fresh code from the person's
 * authenticator app. Raising a level, changing limits, raising the daily cap and Resume ask for it; lowering and Pause
 * never do (a brake is easy). The API checks the code once (lib/auth/step-up.ts) and the permission
 * (settings.security.manage); this dialog only collects it and shows the API's answer.
 */
import { useEffect, useId, useState } from 'react'
import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'

export interface StepUpModalProps {
  open: boolean
  title: string
  /** What the code allows, in one sentence. */
  sentence: string
  busy: boolean
  error: string | null
  onSubmit: (code: string) => void
  onClose: () => void
  /** Passed to the Modal: the Approvals page's "Automate this kind…" passes `fleet-portal` to keep the fleet's light pin. */
  className?: string
}

export function StepUpModal({ open, title, sentence, busy, error, onSubmit, onClose, className }: StepUpModalProps) {
  const [code, setCode] = useState('')
  const id = useId()
  useEffect(() => {
    if (open) setCode('')
  }, [open])
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
            {busy ? 'Checking…' : 'Confirm'}
          </Button>
        </>
      }
    >
      <form
        className="claude-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) onSubmit(code)
        }}
      >
        <p className="claude-note">{sentence}</p>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Two-factor code" required hint="The 6-digit code from your authenticator app." htmlFor={id}>
          <Input
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

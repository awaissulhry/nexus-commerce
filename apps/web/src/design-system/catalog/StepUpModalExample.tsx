'use client'
import { useState } from 'react'
import { StepUpModal } from '../patterns/StepUpModal'
import { Button } from '../primitives/Button'

/** The code a raise asks for. Any six digits but 123456 answer with the API's own wrong-code sentence. */
export function StepUpModalExample() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState('Nothing saved yet')
  return <section id="step-up-modal-example">
    <h3>StepUpModal</h3>
    <p>Before a raise: one sentence that names what rises, the 6-digit code from the authenticator app, and the API&apos;s answer. Six digits enable the button; Enter submits; Escape cancels. A lowering never opens it.</p>
    <Button size="sm" variant="secondary" onClick={() => { setError(null); setOpen(true) }}>Save 2 changes…</Button>
    <StepUpModal open={open} title="Your authenticator code" sentence="It raises the highest bid and the monthly spend cap. Lowering never asks for a code."
      confirmLabel="Save 2 changes" busy={false} error={error} onClose={() => setOpen(false)}
      onSubmit={code => { if (code === '123456') { setOpen(false); setResult('Saved with a code') } else setError('That code is not right. Check your authenticator app.') }} />
    <p role="status">Example result: {result}</p>
  </section>
}

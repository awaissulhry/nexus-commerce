'use client'

/**
 * Approvals grid — edit, then approve (build agent D2, 2026-10-05; PLAN §5).
 *
 * POST /api/agent/fleet/approvals/:id/amend { args: patch } re-runs the tool's OWN checks on the edited arguments
 * (agent-fleet-approvals.routes.ts): its refusal is shown verbatim, and on success the request is REPLACED by a new one
 * with a fresh preview — which the person then reads and approves. Nothing is approved from here.
 *
 * Only for the tools in drawerWords.ts `EDIT_SPECS`; any other request the server could edit shows "ask for a new
 * request" instead of a free-text box over its arguments (a money field typed as text is a hole through the bid rails).
 */
import { useEffect, useId, useState } from 'react'
import type { QueueDetail } from '@nexus/shared/approval-queue'
import { Banner, Field } from '@/design-system/components'
import { Button, Input, Textarea } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { editPatch, editPlan, formatWire, parseEditInput, requestArgsOf } from './drawerWords'
import styles from './ApprovalDrawer.module.css'

export function EditValue({ detail, busy, onReplaced }: {
  detail: QueueDetail
  /** A decision on this row is in flight. */
  busy: boolean
  /** The edit was accepted: the new request's id (null when the server did not name it). */
  onReplaced: (newId: string | null) => void
}) {
  const args = requestArgsOf(detail)
  const plan = editPlan(detail, args)
  const field = plan?.kind === 'form' ? plan.field : null
  const [value, setValue] = useState(field?.initial ?? '')
  const [touched, setTouched] = useState(false)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const hintId = useId()

  // A new request (or another tool) starts from its own value.
  const key = `${detail.id}:${field?.spec.arg ?? ''}:${field?.initial ?? ''}`
  useEffect(() => {
    setValue(field?.initial ?? '')
    setTouched(false)
    setRefusal(null)
  }, [key])

  if (!plan) return null
  if (plan.kind === 'ask') {
    return (
      <section className={styles.section} aria-label="Change the request">
        <p className={styles.muted}>{plan.hint}</p>
      </section>
    )
  }

  const f = plan.field
  const parsed = parseEditInput(f, value)
  const fieldError = touched && !parsed.ok ? parsed.error : undefined
  const hint = [
    f.proposed ? `The request now says ${f.proposed}.` : null,
    'Nexus checks your value with the same rules first; then a new request with your value replaces this one, and you approve that.',
  ].filter(Boolean).join(' ')

  const send = async () => {
    setTouched(true)
    if (!parsed.ok) return
    setSending(true)
    setRefusal(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/agent/fleet/approvals/${encodeURIComponent(detail.id)}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: editPatch(f, parsed.value, args) }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; approvalId?: string } | null
      if (!response.ok) {
        setRefusal(body?.error ?? `The edit was refused (${response.status}).`)
        return
      }
      onReplaced(typeof body?.approvalId === 'string' ? body.approvalId : null)
    } catch {
      setRefusal('Nexus could not be reached. Nothing changed. Try again in a moment.')
    } finally {
      setSending(false)
    }
  }

  const label = f.currency && f.spec.kind === 'money' ? `${f.spec.label} (${f.currency})` : f.spec.label
  return (
    <section className={styles.section} aria-labelledby={`${hintId}-title`}>
      <h3 id={`${hintId}-title`} className={styles.sectionTitle}>Change the value, then approve</h3>
      <form
        className={styles.editForm}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <Field label={label} hint={hint} error={fieldError}>
          {f.spec.kind === 'text' ? (
            <Textarea
              value={value}
              rows={f.spec.maxLength && f.spec.maxLength <= 100 ? 2 : 4}
              maxLength={f.spec.maxLength}
              disabled={sending}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setTouched(true)}
            />
          ) : (
            <Input
              size="md"
              inputMode={f.spec.integer ? 'numeric' : 'decimal'}
              prefix={f.spec.kind === 'money' && f.currency ? f.currency : undefined}
              value={value}
              disabled={sending}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setTouched(true)}
            />
          )}
        </Field>
        {refusal && <Banner tone="danger" title="Nexus refused this value">{refusal}</Banner>}
        <div className={styles.actions}>
          <Button type="submit" size="md" disabled={busy || sending}>
            {sending ? 'Checking…' : parsed.ok ? `Use ${formatWire(f, parsed.value)} instead` : 'Use this value instead'}
          </Button>
        </div>
      </form>
    </section>
  )
}

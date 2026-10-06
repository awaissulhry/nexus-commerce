'use client'

/**
 * CR rebuild 4 — Limits › Account brakes: the anomaly breaker's two limits, on the design system (the old Guardrails
 * "Circuit breaker" card). The fields hold what is SET; an empty field is the default, and the number in force is said
 * under each one. Save asks first (limitsWords.ts `brakeImpact`): a higher limit needs the tick.
 *
 * CR review: only the fields the person edited are sent, and the confirmation is built from a fresh read made just
 * before it asks — a limit changed elsewhere since the tab opened is kept, and the confirmation says so.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Card, Field, useActionConfirm } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import {
  brakeBody, brakeChanges, brakeImpact, brakeText, changedElsewhere, editedFields, inForceWords, parseBrake, setOf, BRAKE_LABEL, euros,
  type Guardrails,
} from './limitsWords'
import styles from './limits.module.css'

export function AccountBrakes() {
  const [g, setG] = useState<Guardrails | null>(null)
  const [readErr, setReadErr] = useState<string | null>(null)
  const [actions, setActions] = useState('')
  const [spend, setSpend] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const canManage = usePermission('ads.automation.manage')
  const confirm = useActionConfirm()

  const read = useCallback(async (): Promise<Guardrails> => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/guardrails`, { cache: 'no-store' })
    if (!r.ok) throw new Error(`The account brakes could not be read (${r.status}).`)
    return (await r.json()) as Guardrails
  }, [])
  const load = useCallback(async () => {
    try {
      const j = await read()
      setG(j)
      setActions(brakeText('actions', j.actionsPerHour.set))
      setSpend(brakeText('spend', j.spendPerHourCents.set))
      setReadErr(null)
    } catch (e) { setReadErr((e as Error).message) }
  }, [read])
  useEffect(() => { void load() }, [load])

  if (!g) {
    return readErr
      ? <Banner tone="danger" title="The account brakes could not be read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{readErr}</Banner>
      : <span className={styles.muted}>Reading the account brakes…</span>
  }

  const a = parseBrake('actions', actions)
  const s = parseBrake('spend', spend)
  const typed = a.ok && s.ok ? { actions: a.value, spend: s.value } : null
  const edited = typed ? editedFields(setOf(g), typed) : []
  const changes = typed ? brakeChanges(g, typed, edited) : []
  const canSave = canManage && a.ok && s.ok && changes.length > 0 && !busy

  const save = async () => {
    if (!typed || edited.length === 0) return
    setBusy(true); setErr(null); setDone(null)
    try {
      // The confirmation is built from what the server holds NOW, and only the edited fields are sent.
      const fresh = await read()
      const now = brakeChanges(fresh, typed, edited)
      const elsewhere = changedElsewhere(g, fresh, edited)
      const impact = brakeImpact(now, elsewhere)
      if (!impact) { await load(); setDone('Nothing to save: the server already holds these numbers.'); return }
      // Cancel keeps the person's typing; the next Save reads the server again.
      if (!(await confirm.ask(impact))) return
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/thresholds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brakeBody(typed, edited)),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not save (${r.status}).`)
      await load()
      setDone('Saved. The new limits apply from the breaker’s next check.')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card
      header="Account brakes"
      description="When automation passes either limit within one hour, Nexus stops all ads automation, as Stop now does. Press Start again to restart it."
    >
      <div className={styles.stack}>
        {err && <Banner tone="danger" title="Not saved">{err}</Banner>}
        {done && <Banner tone="success" title={done} />}
        <div className={styles.fields}>
          <Field
            label={BRAKE_LABEL.actions}
            hint={`${inForceWords('actions', g.actionsPerHour)} Counts the changes of rules only. Leave it empty for the default (${g.actionsPerHour.default}).`}
            error={a.ok ? undefined : a.error}
          >
            <Input
              size="sm"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={actions}
              placeholder={`${g.actionsPerHour.default} (default)`}
              suffix="actions"
              disabled={!canManage || busy}
              onChange={(e) => { setActions(e.target.value); setDone(null) }}
            />
          </Field>
          <Field
            label={BRAKE_LABEL.spend}
            hint={`${inForceWords('spend', g.spendPerHourCents)} Leave it empty for the default (${euros(g.spendPerHourCents.default)}).`}
            error={s.ok ? undefined : s.error}
          >
            <Input
              size="sm"
              type="number"
              min={0.01}
              step="any"
              inputMode="decimal"
              value={spend}
              placeholder={`${g.spendPerHourCents.default / 100} (default)`}
              prefix="€"
              disabled={!canManage || busy}
              onChange={(e) => { setSpend(e.target.value); setDone(null) }}
            />
          </Field>
        </div>
        <span className={styles.muted}>
          Each engine also has its own hourly limit, set on the server. See Set on the server.
        </span>
        <div className={styles.actions}>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Saving…' : changes.length > 0 ? `Review ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}…` : 'Review changes'}
          </Button>
          {changes.length > 0 && !busy && (
            <Button size="sm" variant="secondary" onClick={() => { setActions(brakeText('actions', g.actionsPerHour.set)); setSpend(brakeText('spend', g.spendPerHourCents.set)) }}>
              Discard
            </Button>
          )}
          {!canManage && <span className={styles.muted}>Changing them needs the ads automation permission.</span>}
        </div>
      </div>
      {confirm.element}
    </Card>
  )
}

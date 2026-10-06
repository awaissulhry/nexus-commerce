'use client'
/**
 * MCP full control C9 — Settings › AI › Claude › Rules: how far Claude may go in this business without a person.
 *
 *   Brakes   Pause (a switch: on at once, no code — a brake is easy; off asks for the 2FA code), and the most changes
 *            that may run by rule in 24 hours (lowering at once; raising asks for the code).
 *   Tools    one row per tool Claude is offered: what it does, its level (a Select of the levels the tool allows —
 *            never above its ceiling), and its limits for Auto (edited in a dialog). Lowering a level is sent at once;
 *            raising one, or changing limits, first asks for the person's 2FA code. A list (ToolRows), not a grid: Tab
 *            reaches each Level select and Edit in the order shown, and at phone width each tool stacks (claude.css).
 *
 * The API decides and refuses (claude-control.routes.ts): its sentence is shown as it is. Every tool starts at Ask.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Banner, Card, Field, Modal } from '@/design-system/components'
import { Button, Input, Select, Toggle } from '@/design-system/primitives'
import { claudeApi, ClaudeApiError } from './claudeApi'
import {
  LEVEL_SHORT,
  levelLabel,
  limitFields,
  limitsSummary,
  parseLimits,
  pauseSentence,
  raises,
  raiseText,
  tightens,
  toolReach,
  toolTitle,
  type ClaudeRule,
  type ClaudeRules,
  type ClaudeTrust,
  type Raise,
} from './claudeWords'
import { StepUpModal } from '@/design-system/patterns'

interface RulesActions {
  busy: boolean
  setLevel: (rule: ClaudeRule, level: ClaudeTrust) => void
  editLimits: (rule: ClaudeRule) => void
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'That could not be completed. Try again.')

/**
 * The tools, one row each: the tool, what it does, its Level select, the most it may be set to, its limits for Auto.
 * The 2026-10-02 browser check found Tab held in a grid's header row with no Level select reachable; in this list
 * every Level select and Edit is a Tab stop, in the order shown.
 */
function ToolRows({ tools, actions }: { tools: ClaudeRule[]; actions: RulesActions }) {
  return (
    <div className="claude-tools">
      <div className="claude-tools-head" aria-hidden="true">
        <span>Tool</span><span>What it does</span><span>Level</span><span>At most</span><span>Limits for Auto</span>
      </div>
      <ul className="claude-tools-list" aria-label="Tools Claude is offered">
        {tools.map((rule) => {
          const limits = limitsSummary(rule)
          return (
            <li key={rule.name} className="claude-tool-row">
              <span className="claude-tool">
                <span className="claude-tool-title">{rule.title}</span>
                <span className="claude-sub">{rule.name}</span>
              </span>
              <span className="claude-tool-reach">{toolReach(rule)}</span>
              <span className="claude-tool-level">
                <Select
                  size="sm"
                  aria-label={`Level for ${rule.title}`}
                  value={rule.level}
                  disabled={actions.busy}
                  onChange={(event) => actions.setLevel(rule, event.target.value as ClaudeTrust)}
                >
                  {rule.levels.map((level) => (
                    <option key={level} value={level}>{levelLabel(level, rule.readOnly)}</option>
                  ))}
                </Select>
              </span>
              <span className="claude-tool-ceiling">
                <span className="claude-cell-label">At most </span>{rule.readOnly ? 'On' : LEVEL_SHORT[rule.ceiling]}
              </span>
              <span className="claude-limits">
                <span className="claude-cell-label">Limits for Auto: </span>
                <span className="claude-limits-text">{limits}</span>
                {!rule.readOnly && rule.limitsSchema && (
                  <Button size="xs" variant="secondary" disabled={actions.busy} onClick={() => actions.editLimits(rule)} aria-label={`Edit limits for ${rule.title}`}>
                    Edit
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The limits of one tool, as fields; saving any change then asks for the code. */
function LimitsModal({ rule, onSave, onClose }: { rule: ClaudeRule; onSave: (limits: Record<string, number> | null) => void; onClose: () => void }) {
  const fields = useMemo(() => limitFields(rule.limitsSchema, rule.limits), [rule])
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const base = useId()
  const save = () => {
    const parsed = parseLimits(fields, typed)
    if ('error' in parsed) setError(parsed.error)
    else onSave(parsed.limits)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Limits for ${toolTitle(rule)}`}
      subtitle="When this tool is set to Auto, a change outside these limits waits for a person instead."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onSave(null)}>Back to Nexus defaults</Button>
          <span className="claude-grow" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <form className="claude-form" onSubmit={(event) => { event.preventDefault(); save() }}>
        {error && <Banner tone="danger">{error}</Banner>}
        {fields.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={`${base}-${field.key}`}
            hint={[field.min != null ? `from ${field.min}` : '', field.max != null ? `up to ${field.max}` : ''].filter(Boolean).join(' ') || undefined}
          >
            <Input
              id={`${base}-${field.key}`}
              inputMode="decimal"
              value={typed[field.key] ?? field.value}
              onChange={(event) => setTyped((now) => ({ ...now, [field.key]: event.target.value }))}
            />
          </Field>
        ))}
        <p className="claude-note">Tightening a limit takes effect at once. Loosening one, or going back to the defaults, asks for your two-factor code: limits decide what runs without a person.</p>
      </form>
    </Modal>
  )
}

export function RulesPanel({ rules, onChanged }: { rules: ClaudeRules; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [raise, setRaise] = useState<Raise | null>(null)
  const [raiseError, setRaiseError] = useState<string | null>(null)
  const [limitsFor, setLimitsFor] = useState<ClaudeRule | null>(null)
  const [cap, setCap] = useState(String(rules.autonomy.dailyAutoCap))
  const pauseLabel = useId()
  const capId = useId()
  useEffect(() => setCap(String(rules.autonomy.dailyAutoCap)), [rules.autonomy.dailyAutoCap])

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await work()
      setNotice(done)
      onChanged()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const actions = useMemo<RulesActions>(() => ({
    busy,
    setLevel: (rule, level) => {
      if (level === rule.level) return
      if (raises(rule.level, level)) {
        setRaiseError(null)
        setRaise({ kind: 'level', rule, level })
      } else void run(() => claudeApi.setRule(rule.name, { level }), `${toolTitle(rule)} is now ${LEVEL_SHORT[level]}.`)
    },
    editLimits: (rule) => setLimitsFor(rule),
  }), [busy])

  const submitRaise = async (code: string) => {
    if (!raise) return
    setBusy(true)
    setRaiseError(null)
    try {
      if (raise.kind === 'level') await claudeApi.setRule(raise.rule.name, { level: raise.level, code })
      else if (raise.kind === 'limits') await claudeApi.setRule(raise.rule.name, { limits: raise.limits, code })
      else if (raise.kind === 'cap') await claudeApi.setDailyCap(raise.value, code)
      else await claudeApi.resume(code)
      setNotice(`${raiseText(raise).title}: done.`)
      setRaise(null)
      onChanged()
    } catch (err) {
      setRaiseError(err instanceof ClaudeApiError ? err.message : message(err))
    } finally {
      setBusy(false)
    }
  }

  const saveCap = () => {
    const value = Number(cap)
    if (!Number.isInteger(value) || value < 0) {
      setError('The daily limit is a whole number of changes, 0 or more.')
      return
    }
    if (value > rules.autonomy.dailyAutoCap) {
      setRaiseError(null)
      setRaise({ kind: 'cap', value })
    } else void run(() => claudeApi.setDailyCap(value), `At most ${value} changes may run by rule in 24 hours.`)
  }

  const { autonomy } = rules
  const text = raise ? raiseText(raise) : null
  return (
    <div className="claude-panel">
      {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <Card header="Brakes" description="Stop everything that runs by rule at once, or bound how much may run in a day.">
        <div className="claude-card-body">
          {autonomy.paused && <Banner tone="warning" title="Changes that run by rule are paused">{pauseSentence(autonomy)}</Banner>}
          <div className="claude-row">
            <Toggle
              checked={autonomy.paused}
              aria-labelledby={pauseLabel}
              disabled={busy}
              onChange={(next) => {
                if (next) void run(() => claudeApi.pause(), 'Paused. Every change Claude asks for now waits for a person.')
                else {
                  setRaiseError(null)
                  setRaise({ kind: 'resume' })
                }
              }}
            />
            <span id={pauseLabel}>Pause every change that runs by rule</span>
          </div>
          {!autonomy.paused && <p className="claude-note">{pauseSentence(autonomy)}</p>}
          <Field label="Most changes that may run by rule in 24 hours" hint="Lowering is immediate; raising asks for your two-factor code." htmlFor={capId}>
            <div className="claude-row">
              <Input id={capId} size="sm" inputMode="numeric" value={cap} onChange={(event) => setCap(event.target.value.replace(/\D/g, ''))} disabled={busy} />
              <Button size="sm" variant="secondary" onClick={saveCap} disabled={busy || cap === String(autonomy.dailyAutoCap)}>Save</Button>
            </div>
          </Field>
        </div>
      </Card>

      <Card
        header="What Claude may do here"
        description="Every tool starts at Ask: a person approves each change in Nexus. Lowering a level takes effect at once; letting Claude do more asks for your two-factor code."
      >
        <ToolRows tools={rules.tools} actions={actions} />
      </Card>

      {limitsFor && (
        <LimitsModal
          rule={limitsFor}
          onClose={() => setLimitsFor(null)}
          onSave={(limits) => {
            const rule = limitsFor
            setLimitsFor(null)
            setRaiseError(null)
            // Tightening is a brake: sent at once. Loosening (or a refusal asking for the code) goes through the code.
            if (tightens(limitFields(rule.limitsSchema, rule.limits), limits)) {
              void (async () => {
                setBusy(true)
                setError(null)
                try {
                  await claudeApi.setRule(rule.name, { limits })
                  setNotice(`The limits for ${toolTitle(rule)} are tighter now.`)
                  onChanged()
                } catch (err) {
                  if (err instanceof ClaudeApiError && err.code === 'mfa_required') setRaise({ kind: 'limits', rule, limits })
                  else setError(message(err))
                } finally {
                  setBusy(false)
                }
              })()
            } else setRaise({ kind: 'limits', rule, limits })
          }}
        />
      )}
      <StepUpModal
        open={!!raise}
        title={text?.title ?? ''}
        sentence={text?.sentence ?? ''}
        busy={busy}
        error={raiseError}
        onSubmit={(code) => void submitRaise(code)}
        onClose={() => setRaise(null)}
      />
    </div>
  )
}

'use client'
/**
 * MCP full control C9 — Settings › AI › Claude › Rules: how far Claude may go in this business without a person.
 *
 *   Brakes   Pause (a switch: on and off at once), and the most changes that may run by rule in 24 hours.
 *   Tools    one row per tool Claude is offered: what it does, its level (a Select of the levels the tool allows —
 *            never above its ceiling), and its limits for Auto (edited in a dialog). Every change is sent at once; a
 *            raise (a higher level, looser limits, a higher cap, Resume) needs settings.security.manage, and the
 *            notice says what it lets Claude do (no authenticator code since 2026-10-12, Owner "B"). A list (ToolRows),
 *            not a grid: Tab reaches each Level select and Edit in the order shown, and at phone width each tool
 *            stacks (claude.css).
 *
 * The API decides and refuses (claude-control.routes.ts): its sentence is shown as it is. Every tool starts at Ask.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Banner, Card, Field, Modal } from '@/design-system/components'
import { Button, Input, Select, Toggle } from '@/design-system/primitives'
import { claudeApi } from './claudeApi'
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

interface RulesActions {
  busy: boolean
  setLevel: (rule: ClaudeRule, level: ClaudeTrust) => void
  editLimits: (rule: ClaudeRule) => void
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'That could not be completed. Try again.')

/** A raise is sent at once like any change; its notice says what it lets Claude do. */
function raised(raise: Raise): string {
  const { title, sentence } = raiseText(raise)
  return `${title}: done. ${sentence}`
}

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

/** The limits of one tool, as fields; saving sends them at once. */
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
        <p className="claude-note">Saving takes effect at once. Limits decide what runs without a person: loosening one, or going back to the defaults, needs the security permission.</p>
      </form>
    </Modal>
  )
}

export function RulesPanel({ rules, onChanged }: { rules: ClaudeRules; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
      void run(
        () => claudeApi.setRule(rule.name, { level }),
        raises(rule.level, level) ? raised({ kind: 'level', rule, level }) : `${toolTitle(rule)} is now ${LEVEL_SHORT[level]}.`,
      )
    },
    editLimits: (rule) => setLimitsFor(rule),
  }), [busy])

  const saveCap = () => {
    const value = Number(cap)
    if (!Number.isInteger(value) || value < 0) {
      setError('The daily limit is a whole number of changes, 0 or more.')
      return
    }
    void run(
      () => claudeApi.setDailyCap(value),
      value > rules.autonomy.dailyAutoCap ? raised({ kind: 'cap', value }) : `At most ${value} changes may run by rule in 24 hours.`,
    )
  }

  const { autonomy } = rules
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
                else void run(() => claudeApi.resume(), raised({ kind: 'resume' }))
              }}
            />
            <span id={pauseLabel}>Pause every change that runs by rule</span>
          </div>
          {!autonomy.paused && <p className="claude-note">{pauseSentence(autonomy)}</p>}
          <Field label="Most changes that may run by rule in 24 hours" hint="Takes effect at once. Raising it needs the security permission." htmlFor={capId}>
            <div className="claude-row">
              <Input id={capId} size="sm" inputMode="numeric" value={cap} onChange={(event) => setCap(event.target.value.replace(/\D/g, ''))} disabled={busy} />
              <Button size="sm" variant="secondary" onClick={saveCap} disabled={busy || cap === String(autonomy.dailyAutoCap)}>Save</Button>
            </div>
          </Field>
        </div>
      </Card>

      <Card
        header="What Claude may do here"
        description="Every tool starts at Ask: a person approves each change in Nexus. A new level takes effect at once; letting Claude do more needs the security permission."
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
            const tighter = tightens(limitFields(rule.limitsSchema, rule.limits), limits)
            void run(
              () => claudeApi.setRule(rule.name, { limits }),
              tighter ? `The limits for ${toolTitle(rule)} are tighter now.` : raised({ kind: 'limits', rule, limits }),
            )
          }}
        />
      )}
    </div>
  )
}

'use client'

/**
 * CR rebuild 3 (= ADS AUTONOMY AA-W2-5) — one kind of ad change Claude may make, opened from its Who acts row: what it
 * may do now, its level for this business (Settings › AI › Claude's own rule: the same read, the same save), its limits
 * at Auto, Claude's own brakes (Pause, the daily cap), and — at "Ask me + watch" — the watch week: how many requests
 * would have run alone, what a person did with them, and why the others were outside the limits. Then "Raise to Auto…".
 *
 * Lowering and Pause are plain questions here. Raising and Resume ask for a fresh authenticator code (the server checks
 * it too): the code dialog is a Modal, which would open behind this drawer, so the page closes the drawer, asks for the
 * code, and opens it again (WhoActsGrid).
 */
import { useCallback, useState } from 'react'
import { Button, Select } from '@/design-system/primitives'
import { Banner, Card, Drawer, Field, KeyValue } from '@/design-system/components'
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { claudeApi } from '@/app/settings/ai/claude/claudeApi'
import { limitFields, type ClaudeTrust } from '@/app/settings/ai/claude/claudeWords'
import { LeverConfirm } from './LeverConfirm'
import {
  CLAUDE_MEANS, CLAUDE_WORD, claudeLevelOptions, claudeLimitRows, claudeLowerImpact, claudeName, claudePauseImpact,
  claudeRaises, claudeReachWords, watchReport,
} from './claudeKinds'
import type { ActorRow } from './whoActs'
import styles from './room.module.css'

type ClaudeActorRow = ActorRow & { claude: NonNullable<ActorRow['claude']> }

/** What the page does for this drawer when a step needs the authenticator code. */
export type ClaudeCodeStep = { kind: 'level'; to: ClaudeTrust } | { kind: 'resume' }

export function ClaudeKindDrawer({ row, done, onClose, onChanged, onCode }: {
  row: ClaudeActorRow
  /** A sentence to show at the top after the page saved a step that needed the code. */
  done: string | null
  onClose: () => void
  onChanged: () => void
  /** A raise or Resume: the page asks for the code (closing this drawer while it does) and saves it. */
  onCode: (step: ClaudeCodeStep) => void
}) {
  const { rule, watch, autonomy } = row.claude
  const name = claudeName(rule)
  // The server's own gates (permissions-manifest.ts, claude-trust.service.ts): lowering and Pause need ai.run; raising
  // and Resume also need settings.security.manage and a fresh code.
  const canChange = usePermission('ai.run')
  const canRaise = usePermission('settings.security.manage')
  const [ask, setAsk] = useState<{ impact: ActionImpact; run: () => Promise<string> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const report = watchReport(watch)
  const reach = claudeReachWords(rule)
  const limits = claudeLimitRows(limitFields(rule.limitsSchema, rule.limits ?? rule.defaultLimits))

  const choose = (to: ClaudeTrust) => {
    setErr(null); setSaved(null)
    if (to === rule.level) return
    if (claudeRaises(rule.level, to)) {
      if (!canRaise) { setErr('Raising needs the security permission in this business. Lowering does not.'); return }
      onCode({ kind: 'level', to }); return
    }
    setAsk({
      impact: claudeLowerImpact(name, rule.level, to),
      run: async () => { await claudeApi.setRule(rule.name, { level: to }); return `“${name}” is at ${CLAUDE_WORD[to]} for new requests.` },
    })
  }
  const pause = () => {
    setErr(null); setSaved(null)
    setAsk({
      impact: claudePauseImpact(),
      run: async () => {
        const r = await claudeApi.pause('Paused from the Control Room')
        return r.handedBack > 0 ? `Paused. ${r.handedBack} waiting ${r.handedBack === 1 ? 'change went' : 'changes went'} back to a person.` : 'Paused.'
      },
    })
  }
  const confirm = async () => {
    if (!ask || busy) return
    const step = ask
    setAsk(null); setBusy(true)
    try { setSaved(await step.run()); onChanged() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const cancel = useCallback(() => setAsk(null), [])

  return (
    <Drawer
      open
      onClose={onClose}
      title={name}
      subtitle={`Claude · ${row.what}`}
      width="min(680px, 94vw)"
      overlay={ask ? <LeverConfirm impact={ask.impact} onCancel={cancel} onConfirm={() => void confirm()} /> : undefined}
    >
      <div className={styles.stack} inert={ask ? true : undefined}>
        {err && <Banner tone="danger" title="Not changed">{err}</Banner>}
        {(saved ?? done) && <Banner tone="success" title={saved ?? done ?? ''} />}
        {row.problem && <Banner tone="warning" title="Needs a look">{row.problem}</Banner>}

        <KeyValue
          columns={2}
          items={[
            { label: 'May do now', value: row.inForceWord ?? CLAUDE_WORD[rule.level], hint: row.why },
            { label: 'What it can change', value: reach.reach },
            { label: 'Can it be undone', value: reach.undo },
            { label: 'Claude’s own name for it', value: rule.title },
          ]}
        />

        <Card header="Level">
          <Field
            label="Level for this business"
            hint={!canChange
              ? 'Changing it needs the AI permission.'
              : 'Lowering asks first. Raising asks for your authenticator code. The ads strategy can still hold it lower in a market, a category or a product (Limits › Strategy).'}
          >
            <Select size="sm" value={rule.level} disabled={!canChange || busy} onChange={(e) => choose(e.target.value as ClaudeTrust)}>
              {claudeLevelOptions(rule).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <p className={`${styles.para} ${styles.muted}`}>{CLAUDE_MEANS[rule.level]}</p>
        </Card>

        {(rule.level === 'watch' || report) && (
          <Card header="The watch week" description={report?.since ?? 'Not watched in the last 7 days.'}>
            {report ? (
              <div className={styles.stack}>
                <KeyValue items={report.lines} />
                {report.reasons.length > 0 && (
                  <KeyValue items={report.reasons.map((r) => ({ label: `Outside your limits (${r.count})`, value: r.why }))} />
                )}
              </div>
            ) : <span className={styles.muted}>Nothing was asked while it was watched.</span>}
            {rule.level === 'watch' && rule.levels.includes('auto') && canRaise && (
              <div className={styles.actionsRow}>
                <Button size="sm" variant="primary" onClick={() => onCode({ kind: 'level', to: 'auto' })}>Raise to Auto…</Button>
              </div>
            )}
          </Card>
        )}

        <Card header="Its limits at Auto" description="A change outside these limits always waits for a person.">
          {limits.length > 0 ? <KeyValue items={limits} /> : <span className={styles.muted}>No limits of its own.</span>}
        </Card>

        {autonomy && (
          <Card header="Claude’s brakes" description="For every kind of change Claude makes, not only this one.">
            <KeyValue
              columns={2}
              items={[
                { label: 'Changes by rule', value: autonomy.paused ? 'Paused' : 'On', hint: autonomy.paused && autonomy.reason ? autonomy.reason : undefined },
                { label: 'Daily limit', value: `${autonomy.dailyAutoCap} changes by rule a day`, hint: `${autonomy.autoRunsLastDay} in the last 24 hours` },
              ]}
            />
            <div className={styles.actionsRow}>
              {autonomy.paused
                ? <Button size="sm" variant="secondary" disabled={!canRaise || busy} onClick={() => onCode({ kind: 'resume' })}>Resume…</Button>
                : <Button size="sm" variant="danger-outline" disabled={!canChange || busy} onClick={pause}>Pause…</Button>}
              <Button asChild size="sm" variant="secondary">
                <Link href="/settings/ai/claude">Change the daily limit (Settings › AI › Claude)</Link>
              </Button>
            </div>
          </Card>
        )}
      </div>
    </Drawer>
  )
}

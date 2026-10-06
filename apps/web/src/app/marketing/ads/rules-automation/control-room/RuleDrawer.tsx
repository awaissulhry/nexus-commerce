'use client'

/**
 * CR rebuild 2 — one rule, opened from its Who acts row: what it does, where, what it may do now and why, its level
 * (every move asks first; a level above the rule's ceiling is listed, held, and says why), and the graduation evidence.
 *
 * Graduation (ACR.4.1): only `ready` may present itself as an invitation. A rule that merely RAN cleanly is never
 * dressed as a rule you agreed with — the level is always the person's choice, never pre-selected here.
 */
import { useCallback, useState } from 'react'
import { Button, Select } from '@/design-system/primitives'
import { Banner, Card, Drawer, Field, KeyValue } from '@/design-system/components'
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { getBackendUrl } from '@/lib/backend-url'
import { LeverConfirm } from './LeverConfirm'
import { LEVEL_WORD, isLevel, levelRank, type Level } from './levelWords'
import { ceilingWords, ruleLevelOptions, ruleMove, type ActorRow, type Readiness, type Rule } from './whoActs'
import { withoutServerNames } from './levelWords'
import { agoWords } from './timeWords'
import styles from './room.module.css'

const euros = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100)

function scopeWords(r: Rule): string {
  const s = r.scope
  if (!s || s.kind === 'account') return 'Every campaign it can reach'
  return s.name ?? s.kind
}

export function RuleDrawer({ row, readiness, onClose, onChanged }: {
  row: ActorRow & { rule: Rule }
  readiness: Readiness | undefined
  onClose: () => void
  onChanged: () => void
}) {
  const rule = row.rule
  const canChange = usePermission('ads.campaigns.manage')
  const [ask, setAsk] = useState<{ impact: ActionImpact; to: Level } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const choose = (to: Level) => {
    setErr(null); setDone(null)
    const move = ruleMove(rule, to)
    if (!move) return
    if ('refused' in move) { setErr(move.refused); return }
    setAsk({ impact: move.impact, to })
  }

  const send = async () => {
    if (!ask || busy) return
    const to = ask.to
    setAsk(null); setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: to }),
      })
      if (!r.ok) {
        // 409: the server refuses a level above the rule's ceiling, with the policy's own words on `message`.
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string }
        throw new Error(r.status === 409 ? (j.message ?? 'That level is above this rule’s ceiling.') : (j.error ?? `Could not change the level (${r.status}).`))
      }
      setDone(`“${rule.name}” is at ${LEVEL_WORD[to]} from its next run.`)
      onChanged()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const cancel = useCallback(() => setAsk(null), [])

  const caps = [
    rule.caps.perDay != null ? `at most ${rule.caps.perDay} changes a day` : null,
    rule.caps.perDayCents != null ? `at most ${euros(rule.caps.perDayCents)} a day` : null,
    rule.caps.perExecutionCents != null ? `at most ${euros(rule.caps.perExecutionCents)} a run` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Drawer
      open
      onClose={onClose}
      title={rule.name}
      subtitle={row.what}
      width="min(680px, 94vw)"
      overlay={ask ? <LeverConfirm impact={ask.impact} onCancel={cancel} onConfirm={() => void send()} /> : undefined}
    >
      <div className={styles.stack} inert={ask ? true : undefined}>
        {err && <Banner tone="danger" title="Not changed">{err}</Banner>}
        {done && <Banner tone="success" title={done} />}
        {row.problem && <Banner tone="warning" title="Needs a look">{row.problem}</Banner>}
        {rule.runsAsReason && (
          <Banner tone="info" title="It asks first">
            {withoutServerNames(rule.runsAsReason, 'The rule itself is set to ask first. Change it in the rule to let it act alone.')}
          </Banner>
        )}

        <KeyValue
          columns={2}
          items={[
            { label: 'May do now', value: LEVEL_WORD[row.inForce], hint: row.why },
            { label: 'Market', value: rule.marketplace ?? 'Every market' },
            { label: 'Applies to', value: scopeWords(rule), hint: rule.reach ? `${rule.reach.campaigns} of ${rule.reach.total} campaigns` : undefined },
            { label: 'What it changes', value: rule.writes === false ? 'Nothing — it only alerts' : row.what },
            { label: 'This week', value: row.week },
            { label: 'Last run', value: agoWords(rule.lastExecutedAt) },
            ...(caps ? [{ label: 'Its own limits', value: caps }] : []),
          ]}
        />

        <Card header="Level">
          <Field
            label="Level for this rule"
            hint={!canChange
              ? 'Changing it needs the ads campaigns permission.'
              : levelRank(rule.ceiling) < levelRank('AUTO')
                ? `Every move asks first. Highest allowed: ${LEVEL_WORD[rule.ceiling]}. ${ceilingWords(rule.ceilingReason)}`
                : 'Every move asks first and takes effect at its next run.'}
          >
            <Select size="sm" value={rule.level} disabled={!canChange || busy} onChange={(e) => { if (isLevel(e.target.value)) choose(e.target.value) }}>
              {ruleLevelOptions(rule).map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </Select>
          </Field>
        </Card>

        {readiness && readiness.verdict !== 'capped' && (
          <Banner
            tone={readiness.verdict === 'ready' ? 'success' : readiness.verdict === 'failing' ? 'warning' : 'neutral'}
            title={readiness.verdict === 'ready' ? 'The evidence supports Auto' : readiness.verdict === 'failing' ? 'It is failing' : 'Not enough evidence for Auto yet'}
          >
            {withoutServerNames(readiness.summary, '')} Nexus suggests Auto after you applied its suggestions unchanged in separate weeks with no failures. You choose the level.
          </Banner>
        )}

        <div>
          <Button asChild size="sm" variant="secondary">
            <Link href="/marketing/ads/rules-automation/automations">Edit rules on the Automations page</Link>
          </Button>
        </div>
      </div>
    </Drawer>
  )
}

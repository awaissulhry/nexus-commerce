'use client'

/**
 * ADS AUTONOMY W1-4 — the editor of ONE strategy row: the market, or one category or product in it. Every field shows
 * its value here (empty = not set here), what is in force and where it comes from ("Inherited from the market: 30 %"),
 * its unit, and who reads it — or "Stored only" when no engine does yet (the registry's readBy, never claimed).
 *
 * Presentational: the tab owns the draft, the preview and the save. Design-system controls only; layout in
 * strategy.module.css.
 */
import type { ReactNode } from 'react'
import { Card, Field } from '@/design-system/components'
import { Checkbox, InfoTip, Input, SegmentedControl, Select, Tag, Textarea } from '@/design-system/primitives'
import { currencySymbol } from '../../../_shell/adsMarkets'
import type { ClaudeLevel, EffectiveMarket, FieldEntry, ShadowCampaign } from './strategyApi'
import {
  CLAUDE_ACTION_LABEL,
  CLAUDE_LEVEL_SHORT,
  FIELD_LABEL,
  GOALS,
  MONEY_FIELDS,
  claudeRow,
  fieldAllowed,
  inForceLine,
  readByWords,
  type ClaudeActionKey,
  type Draft,
  type FieldKey,
  type Scope,
  type Window,
} from './strategyWords'
import styles from './strategy.module.css'

export interface StrategyEditorProps {
  scope: Scope
  draft: Draft
  onDraft: (patch: Partial<Draft>) => void
  effective: EffectiveMarket | null
  errors: Partial<Record<FieldKey, string>>
  currency: string | null
  /** Changing needs ads.automation.manage and permission to see ad-spend money; without either, everything is shown only. */
  readOnly: boolean
  canSeeMoney: boolean
  /** The market's campaigns whose own target ACoS wins over the strategy, and whether this save clears them (market only). */
  shadows: { list: ShadowCampaign[]; count: number }
  /** The fields no engine or door reads yet (the API's notReadYet, from the registry). */
  notReadYet: readonly string[]
  clearTargets: boolean
  onClearTargets: (clear: boolean) => void
}

const CLAUDE_CHOICES: ReadonlyArray<{ value: ClaudeLevel | ''; label: string }> = [
  { value: '', label: 'Same as Who acts' },
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask me' },
  { value: 'confirm', label: 'Ask me + code' },
  { value: 'watch', label: 'Ask me + watch' },
  { value: 'auto', label: 'Auto' },
]
const WINDOWS: ReadonlyArray<{ value: Window; label: string }> = [
  { value: '', label: 'Not set' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
]

export function StrategyEditor(p: StrategyEditorProps) {
  const { scope, draft, onDraft, effective, errors, currency, readOnly, canSeeMoney } = p
  const entries = new Map((effective?.fields ?? []).map((f) => [f.field, f] as const))
  const entry = (field: FieldKey): FieldEntry | undefined => entries.get(field)
  const symbol = currencySymbol(currency)
  const hidden = (field: FieldKey) => !canSeeMoney && MONEY_FIELDS.includes(field)
  const level = scope.level
  const disabled = readOnly

  /** What is in force here and where it comes from, then who reads it. */
  const hint = (field: FieldKey, extra?: ReactNode) => {
    const reader = readByWords(field === 'claudeAutonomy' ? claudeReaders(p.notReadYet) : entry(field)?.readBy)
    const line = hidden(field) ? 'Hidden: seeing ad-spend money needs permission.' : inForceLine(field, entry(field), scope, currency)
    return (
      <span className={styles.hint}>
        {line && <span>{line}</span>}
        {extra}
        <span className={styles.reader}>
          <Tag tone={reader.storedOnly ? 'neutral' : 'info'}>{reader.storedOnly ? 'Stored only' : 'Read'}</Tag>
          <span className={styles.readerText}>
            {reader.storedOnly ? 'No engine reads this yet.' : reader.text.replace(/^Read by /, 'By ')}
            {reader.full && <> <InfoTip tip={reader.full} /></>}
          </span>
        </span>
      </span>
    )
  }

  const moneyInput = (field: FieldKey, key: keyof Draft, label: string, extraHint?: ReactNode) => (
    <Field label={label} hint={hint(field, extraHint)} error={errors[field]}>
      <Input
        inputMode="decimal" prefix={symbol || undefined} placeholder={hidden(field) ? 'Hidden' : 'Not set'}
        value={hidden(field) ? '' : (draft[key] as string)} disabled={disabled || hidden(field)}
        onChange={(e) => onDraft({ [key]: e.target.value } as Partial<Draft>)}
      />
    </Field>
  )
  const wholeInput = (field: FieldKey, key: keyof Draft, label: string, suffix: string) => (
    <Field label={label} hint={hint(field)} error={errors[field]}>
      <Input
        inputMode="numeric" suffix={suffix} placeholder="Not set" value={draft[key] as string} disabled={disabled}
        onChange={(e) => onDraft({ [key]: e.target.value.replace(/[^\d]/g, '') } as Partial<Draft>)}
      />
    </Field>
  )
  const smallWhole = (key: keyof Draft, label: string, suffix?: string) => (
    <Field label={label}>
      <Input inputMode="numeric" size="sm" suffix={suffix} placeholder="—" value={draft[key] as string} disabled={disabled}
        onChange={(e) => onDraft({ [key]: e.target.value.replace(/[^\d]/g, '') } as Partial<Draft>)} />
    </Field>
  )
  const windowSelect = (key: 'harvestWindowDays' | 'negateWindowDays') => (
    <Field label="Days looked at">
      <Select size="sm" value={draft[key]} disabled={disabled} onChange={(e) => onDraft({ [key]: e.target.value as Window } as Partial<Draft>)}>
        {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
      </Select>
    </Field>
  )

  return (
    <div className={styles.cards}>
      <div className={styles.stack}>
        <Card header="Goal" headingLevel={3} description="What the ads should do here, and why. Claude reads it; no engine sets a number from it.">
          <div className={styles.fields}>
            <Field label={FIELD_LABEL.goal} hint={hint('goal')} error={errors.goal}>
              <Select value={draft.goal} disabled={disabled} onChange={(e) => onDraft({ goal: e.target.value })}>
                <option value="">{level === 'MARKET' ? 'Not set' : 'Not set here (inherit)'}</option>
                {GOALS.map((g) => <option key={g.value} value={g.value}>{`${g.label} — ${g.hint}`}</option>)}
              </Select>
            </Field>
            <Field label={FIELD_LABEL.goalNote} hint={hint('goalNote', <span>Your own words, for Claude and for whoever reads this later.</span>)} error={errors.goalNote}>
              <Textarea rows={3} maxLength={2000} value={draft.goalNote} disabled={disabled} placeholder="Not set" onChange={(e) => onDraft({ goalNote: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card header="Target" headingLevel={3} description="The advertising cost of sales the ads aim at here, as a whole percent.">
          <div className={styles.fields}>
            <SegmentedControl
              ariaLabel="Kind of target" size="sm" wrap disabled={disabled || hidden('target')} value={draft.targetKind}
              onChange={(v) => onDraft({ targetKind: v === 'TACOS' ? 'TACOS' : 'ACOS' })}
              options={[{ value: 'ACOS', label: 'ACoS — of ad sales' }, { value: 'TACOS', label: 'TACoS — of all sales' }]}
            />
            <Field
              label={draft.targetKind === 'TACOS' ? 'Target TACoS' : 'Target ACoS'} error={errors.target}
              hint={hint('target', draft.targetKind === 'TACOS'
                ? <span>Nexus&apos;s engines steer by ACoS only: a TACoS target is stored and shown, Claude steers by it, and the engines use the next ACoS target.</span>
                : undefined)}
            >
              <Input
                inputMode="numeric" suffix="%" placeholder={hidden('target') ? 'Hidden' : 'Not set'} disabled={disabled || hidden('target')}
                value={hidden('target') ? '' : draft.targetPct} onChange={(e) => onDraft({ targetPct: e.target.value.replace(/[^\d]/g, '') })}
              />
            </Field>
          </div>
        </Card>
      </div>
      <div className={styles.stack}>
        <Card header="Money limits" headingLevel={3} description={`In ${currency ?? "the market's currency"}. Empty means not set here; a limit set in two places binds at the stricter one.`}>
          <div className={styles.fields}>
            {moneyInput('monthlySpendCapCents', 'monthlySpendCap', `${FIELD_LABEL.monthlySpendCapCents} (a calendar month)`,
              <span>Empty is no cap. 0 is refused: on the Budget Manager it means no cap.</span>)}
            <div className={styles.pair}>
              {moneyInput('minBidCents', 'minBid', FIELD_LABEL.minBidCents)}
              {moneyInput('maxBidCents', 'maxBid', FIELD_LABEL.maxBidCents)}
            </div>
            {wholeInput('maxChangePct', 'maxChangePct', FIELD_LABEL.maxChangePct, '%')}
            {fieldAllowed('maxActionsPerRun', level) && wholeInput('maxActionsPerRun', 'maxActionsPerRun', FIELD_LABEL.maxActionsPerRun, 'changes')}
          </div>
        </Card>

        <Card header={level === 'MARKET' ? 'Temporary stop' : 'Stop and protection'} headingLevel={3}
          description="A stop lowers bids, it never pauses (a restart after a pause takes about an hour).">
          <div className={styles.fields}>
            {moneyInput('stop', 'stopBid', 'Stop bid', <span>From {symbol}0.02 to {symbol}1.00.</span>)}
            {fieldAllowed('protect', level) && (
              <Field label="Protect it" hint={hint('protect', <span>Protected: no engine, rule or schedule negates its ASIN or stops it to save money. Safety stops still apply.</span>)} error={errors.protect}>
                <Select value={draft.protect} disabled={disabled} onChange={(e) => onDraft({ protect: e.target.value as Draft['protect'] })}>
                  <option value="">Not set here (inherit)</option>
                  <option value="yes">Protected</option>
                  <option value="no">Not protected (opts out of a broader protection)</option>
                </Select>
              </Field>
            )}
          </div>
        </Card>
      </div>

      <Card className={styles.wide} header="Search terms" headingLevel={3} description="When an engine turns a search term into its own keyword, or blocks it. Fill a group whole, or leave it empty to inherit.">
        <div className={styles.groups}>
          <div className={styles.group} role="group" aria-label={FIELD_LABEL.harvest}>
            <p className={styles.groupLabel}>{FIELD_LABEL.harvest}</p>
            <div className={styles.quad}>
              {smallWhole('harvestMinOrders', 'Orders at least')}
              {smallWhole('harvestMinClicks', 'Clicks at least')}
              {canSeeMoney ? smallWhole('harvestMaxAcosPct', 'ACoS at most', '%') : null}
              {windowSelect('harvestWindowDays')}
            </div>
            {errors.harvest && <p className={styles.groupError} role="alert">{errors.harvest}</p>}
            {hint('harvest')}
          </div>
          <div className={styles.group} role="group" aria-label={FIELD_LABEL.negate}>
            <p className={styles.groupLabel}>{FIELD_LABEL.negate}</p>
            <div className={styles.quad}>
              {smallWhole('negateMinClicks', 'Clicks at least')}
              {canSeeMoney ? (
                <Field label="Spend at least">
                  <Input inputMode="decimal" size="sm" prefix={symbol || undefined} placeholder="—" value={draft.negateMinSpend} disabled={disabled}
                    onChange={(e) => onDraft({ negateMinSpend: e.target.value })} />
                </Field>
              ) : null}
              {smallWhole('negateMaxOrders', 'Orders at most')}
              {windowSelect('negateWindowDays')}
            </div>
            {errors.negate && <p className={styles.groupError} role="alert">{errors.negate}</p>}
            {hint('negate')}
          </div>
        </div>
      </Card>

      <Card className={styles.wide} header="What Claude may do" headingLevel={3}
        description="Per kind of ad change, here. The strategy can only hold Claude lower than its level in Who acts — never higher.">
        <div className={styles.fields}>
          <p className={styles.note}>
            Off: not offered to Claude. Ask me: a person approves each change in Nexus. Ask me + code: the person who
            asked types their authenticator code in Claude. Ask me + watch: a person approves each change, and Nexus
            records whether Auto would have run it. Auto: runs by your rule, inside its limits.
          </p>
          <ul className={styles.claudeList} aria-label="What Claude may do, per kind of ad change">
            <li className={`${styles.claudeRow} ${styles.claudeHeadRow}`} aria-hidden>
              <span>Kind of change</span><span>Level in Who acts</span><span>Here</span><span>Result</span>
            </li>
            {(effective?.claude ?? []).map((c) => {
              const own = draft.claude[c.action] ?? ''
              const row = claudeRow(c, own, scope)
              const name = CLAUDE_ACTION_LABEL[c.action as ClaudeActionKey] ?? c.action
              return (
                <li key={c.action} className={styles.claudeRow}>
                  <span className={styles.claudeName}>{name}</span>
                  <span className={styles.claudeRule}><span className={styles.claudeSub}>Level in Who acts</span>{row.rule}</span>
                  <span className={styles.claudeChoice}>
                    <Select size="sm" aria-label={`${name}: Claude's level here`} value={own} disabled={disabled}
                      onChange={(e) => onDraft({ claude: { ...draft.claude, [c.action]: (e.target.value || undefined) as ClaudeLevel | undefined } })}>
                      {CLAUDE_CHOICES.map((o) => <option key={o.value} value={o.value}>{o.value === '' && row.inheritedLevel ? `Not set (inherits ${CLAUDE_LEVEL_SHORT[row.inheritedLevel]})` : o.label}</option>)}
                    </Select>
                  </span>
                  <span className={styles.claudeResult}>
                    <span className={styles.claudeSub}>Result</span>
                    {row.result}
                    {row.noEffect && <span className={styles.claudeNote}>No effect here: the level in Who acts is already at or below it.</span>}
                    {!own && row.inherited && <span className={styles.claudeNote}>{row.inherited}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
          {errors.claudeAutonomy && <p className={styles.groupError} role="alert">{errors.claudeAutonomy}</p>}
          {hint('claudeAutonomy')}
          {wholeInput('reviewEveryDays', 'reviewEveryDays', FIELD_LABEL.reviewEveryDays, 'days')}
        </div>
      </Card>

      {p.shadows.count > 0 && (
        <Card className={styles.wide} header={`${p.shadows.count} ${p.shadows.count === 1 ? 'campaign has its' : 'campaigns have their'} own target ACoS`} headingLevel={3}
          description="A campaign's own target ACoS wins over the strategy (your decision): these campaigns keep their own.">
          <div className={styles.fields}>
            <ul className={styles.shadowList}>
              {p.shadows.list.map((c) => (
                <li key={c.campaignId}>{c.name}: {c.targetAcosPct != null ? `${c.targetAcosPct} %` : 'hidden'}</li>
              ))}
              {p.shadows.count > p.shadows.list.length && <li>and {p.shadows.count - p.shadows.list.length} more</li>}
            </ul>
            {level === 'MARKET' ? (
              <Checkbox
                checked={p.clearTargets} disabled={disabled} onChange={(e) => p.onClearTargets(e.target.checked)}
                label="Clear their own targets when I save, so the strategy's target applies to them (Undo puts them back)"
              />
            ) : (
              <p className={styles.note}>They are cleared from the market strategy, or one by one on the campaign.</p>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

/**
 * Who reads what Claude may do alone: Claude's door (W1-8), unless the API lists the field as read by nothing. The
 * effective view leaves this field out of its list, so its reader is named here, gated on the registry's answer.
 */
function claudeReaders(notReadYet: readonly string[]): string[] {
  return notReadYet.includes('claudeAutonomy') ? [] : ['Claude, on every ad change it asks for']
}

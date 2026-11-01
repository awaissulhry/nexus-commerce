'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, Save } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PanelRead } from '../../../../record-panels/model'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { AlertRule, RuleChoices, RuleKindInfo, RuleTest, RuleTimer } from '../api'
import { changeCount, changeHeld, changesOf, defaultRecipient, draftOf, draftProblems, newDraft, placeOptions, placeValue, SEVERITIES, type RuleDraft } from '../model'
import { RuleSentence } from './RuleSentence'
import '../rules.css'

/** The rule dialog's data (the page's view model holds it; the dialog keeps the draft itself). */
export interface RuleDialogState {
  /** `edit` a rule (its popup); `new` a rule of a kind (Add rule, New rule). */
  readonly mode: 'edit' | 'new'
  readonly rule: AlertRule | null
  /** New: the kinds that may be chosen (the date kinds only on Admin › Reminders & timers). */
  readonly kinds: readonly RuleKindInfo[]
  /** The roles and places offered (read when the person may keep rules); null: not read (read only). */
  readonly choices: PanelRead<RuleChoices> | null
  /** The last dry run of the numbers shown (null: none yet). */
  readonly test: PanelRead<RuleTest> | null
  /** A date rule's timers (alerts.rules.manage); null: not shown. */
  readonly timers: PanelRead<readonly RuleTimer[]> | null
  /** A refused save in words (a key of `rules`). */
  readonly problem: string | null
  /** Design cases: the draft as changed. */
  readonly draft?: RuleDraft
}

export interface RuleDialogProps {
  readonly state: RuleDialogState
  /** Every rule the reader sees (a new rule's defaults; the rule a new one's dry run asks). */
  readonly rules: readonly AlertRule[]
  readonly offline: boolean
  readonly busy: boolean
  readonly prefix: string
  onSave?: (draft: RuleDraft) => Promise<boolean>
  onTest?: (draft: RuleDraft, ruleId: string) => void
  onRetryChoices?: () => void
  onRetryTimers?: () => void
  onClose: () => void
}

/**
 * The rule dialog (design home.alerts popup `rule` "Rule: hold longer than…" and admin.automation popup `rule`; ⌘S · Esc):
 * the rule as ONE sentence with its parts in place (RuleSentence), on or off, its severity; a dry run of the numbers
 * shown ("Would find 3 records now · raised 2 alerts in the last 7 days" — counted now: no snapshot of last week exists);
 * a date rule's timers; Save rule with what changed. A person who may not keep the rule reads the same sentence, every
 * control held with why. The design's EditModeBar speaks English only: the footer says the unsaved changes itself.
 */
export function RuleDialog(props: RuleDialogProps) {
  return (
    <WithMessages namespaces={['rules']}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ state, rules, offline, busy, prefix, onSave, onTest, onRetryChoices, onRetryTimers, onClose }: RuleDialogProps) {
  const t = useT('rules')
  const locale = useLocale()
  const choices = state.choices?.status === 'ready' ? state.choices.data : null
  const rule = state.mode === 'edit' ? state.rule : null
  const places = useMemo(() => placeOptions(choices, rule ? { value: placeValue(rule.place), label: rule.place.label } : null), [choices, rule])
  const [draft, setDraft] = useState<RuleDraft | null>(() => state.draft ?? (rule ? draftOf(rule) : state.kinds[0] ? newDraft(state.kinds[0], rules, places, choices?.roles) : null))
  // A new rule: the place offered first and the kind's role come with the choices.
  const placed = useRef(false)
  useEffect(() => {
    if (state.mode !== 'new' || placed.current || !choices || !draft) return
    placed.current = true
    setDraft({ ...draft, place: places[0]?.value ?? '', recipientRoleId: draft.recipientRoleId ?? defaultRecipient(draft.ruleKind, rules, choices.roles) })
  }, [state.mode, choices, draft, places, rules])

  const canChange = state.mode === 'new' ? true : (rule?.canChange ?? false)
  const held = changeHeld({ canChange, offline, busy })
  const heldText = held ? t(held) : null
  const editing = canChange && choices !== null
  const problems = draft ? draftProblems(draft) : []
  const changes = rule && draft ? changesOf(rule, draft) : null
  const count = changes ? changeCount(changes) : 0
  const testTarget = rule?.id ?? (draft ? (rules.find((entry) => entry.ruleKind === draft.ruleKind)?.id ?? null) : null)

  const saveHeld =
    heldText ??
    (state.mode === 'new' && !draft ? t('held.noKind') : null) ??
    (canChange && !choices ? t('held.choices') : null) ??
    (problems.length > 0 ? t('held.problems') : null) ??
    (state.mode === 'edit' && count === 0 ? t('held.noChange') : null)
  const save = () => {
    if (saveHeld || !draft || !onSave) return
    void onSave(draft)
  }
  const saveRef = useRef(save)
  saveRef.current = save
  // ⌘S / Ctrl+S saves (the browser's own save is not wanted here).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const kindOf = draft?.ruleKind ?? null
  const title = state.mode === 'new' ? t('dialog.newTitle') : kindOf ? t('dialog.title', { kind: t(`kind.${kindOf}`) }) : t('dialog.reading')
  const testHeld = !draft ? t('held.noKind') : problems.length > 0 ? t('held.problems') : !testTarget ? t('test.noRuleOfKind') : offline ? t('held.offline') : state.test?.status === 'loading' ? t('test.running') : null
  const href = (record: { type: string; id: string; label: string | null }) => `${prefix}${recordAddress({ type: record.type, id: record.id, label: record.label ?? undefined }, OFFICE_PAGES)}`

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      subtitle={rule?.builtIn ? t('dialog.builtIn') : undefined}
      footer={
        <span className="fw-rule-footer">
          {count > 0 && <span className="fw-rule-muted">{t('dialog.unsaved', { count })}</span>}
          <span className="grow" />
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          {canChange && (
            <Button variant="primary" heldReason={saveHeld} onClick={save} aria-keyshortcuts="Meta+S Control+S">
              <Save size={14} aria-hidden /> {t(state.mode === 'new' ? 'dialog.create' : 'dialog.save')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-rule-dialog">
        {state.problem && <Banner tone="danger" title={t(state.problem)} />}
        {!canChange && <Banner tone="info" title={t('held.readOnly')} />}
        {canChange && state.choices?.status === 'error' && (
          <Banner tone="danger" title={t(state.choices.problem)} action={onRetryChoices ? <Button size="sm" onClick={onRetryChoices}>{t('retry')}</Button> : undefined} />
        )}

        {state.mode === 'new' && (
          <Field label={t('dialog.kind')}>
            <Select
              value={draft?.ruleKind ?? ''}
              disabled={heldText !== null}
              onChange={(event) => {
                const kind = state.kinds.find((entry) => entry.kind === event.target.value)
                if (kind) setDraft({ ...newDraft(kind, rules, places, choices?.roles), place: draft?.place ?? places[0]?.value ?? '' })
              }}
            >
              {state.kinds.map((kind) => (
                <option key={kind.kind} value={kind.kind}>
                  {t(`kind.${kind.kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {draft ? (
          <>
            <div className="fw-rule-row">
              <span className="fw-rule-switch">
                <Toggle checked={draft.enabled} disabled={!editing || heldText !== null} title={heldText ?? undefined} aria-label={t('dialog.onLabel')} onChange={(next) => setDraft({ ...draft, enabled: next })} />
                <Tag tone={draft.enabled ? 'success' : 'neutral'}>{t(draft.enabled ? 'state.on' : 'state.off')}</Tag>
              </span>
              <Field label={t('dialog.severity')}>
                <Select value={draft.severity} disabled={!editing || heldText !== null} title={heldText ?? undefined} onChange={(event) => setDraft({ ...draft, severity: event.target.value as RuleDraft['severity'] })}>
                  {SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {t(`severity.${severity}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {!draft.enabled && <p className="fw-rule-muted">{t('dialog.offHint')}</p>}

            <section className="fw-rule-part" aria-labelledby="fw-rule-sentence-h">
              <h3 id="fw-rule-sentence-h" className="fw-rule-h">
                {t('dialog.sentence')}
              </h3>
              {canChange && !choices && state.choices?.status === 'loading' ? (
                <Skeleton height={40} />
              ) : (
                <RuleSentence
                  draft={draft}
                  mode={editing ? 'edit' : 'read'}
                  names={{ place: rule?.place.label ?? null, recipient: rule?.recipient?.name ?? null }}
                  places={places}
                  roles={choices?.roles ?? []}
                  held={heldText}
                  onChange={setDraft}
                />
              )}
              {draft.email && <p className="fw-rule-muted">{t('dialog.emailHint')}</p>}
            </section>

            <section className="fw-rule-part" aria-labelledby="fw-rule-test-h">
              <h3 id="fw-rule-test-h" className="fw-rule-h">
                {t('test.title')}
              </h3>
              <div className="fw-rule-test">
                <Button size="sm" variant="secondary" heldReason={testHeld} onClick={() => testTarget && onTest?.(draft, testTarget)}>
                  <FlaskConical size={13} aria-hidden /> {t('test.go')}
                </Button>
                {state.test?.status === 'ready' && (
                  <span>
                    {t(state.test.data.complete ? 'test.found' : 'test.foundAtLeast', { count: state.test.data.wouldFind })}
                    {rule && ` · ${t('test.fired', { count: state.test.data.fired7Days })}`}
                  </span>
                )}
                {state.test?.status === 'error' && <span className="fw-rule-problem">{t(state.test.problem)}</span>}
              </div>
              {state.test?.status === 'ready' && state.test.data.sample.length > 0 && (
                <ul className="fw-rule-sample" aria-label={t('test.sample')}>
                  {state.test.data.sample.map((entry) => (
                    <li key={entry.record.id}>
                      <a href={href(entry.record)}>{entry.record.label}</a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="fw-rule-muted">{t(rule ? 'test.honest' : 'test.newRule')}</p>
            </section>

            {state.timers && (
              <section className="fw-rule-part" aria-labelledby="fw-rule-timers-h">
                <h3 id="fw-rule-timers-h" className="fw-rule-h">
                  {rule?.timers ? t('timers.titleCount', { count: rule.timers.pending }) : t('timers.title')}
                </h3>
                {rule?.timers?.nextFireAt && <p className="fw-rule-muted">{t('timers.next', { date: formatDateTime(rule.timers.nextFireAt, { locale }) })}</p>}
                {state.timers.status === 'loading' ? (
                  <Skeleton height={60} />
                ) : state.timers.status === 'error' ? (
                  <Banner tone="danger" title={t(state.timers.problem)} action={onRetryTimers ? <Button size="sm" onClick={onRetryTimers}>{t('retry')}</Button> : undefined} />
                ) : state.timers.data.length === 0 ? (
                  <p className="fw-rule-muted">{t('timers.none')}</p>
                ) : (
                  <ul className="fw-rule-timers" aria-label={t('timers.title')}>
                    {state.timers.data.map((timer) => (
                      <li key={timer.id}>
                        <Tag tone={timer.status === 'PENDING' ? 'info' : timer.status === 'FIRED' ? 'success' : 'neutral'}>{t(`timers.status.${timer.status}`)}</Tag>
                        <a href={href(timer.record)}>{timer.record.label ?? t('timers.record')}</a>
                        <span className="fw-rule-muted">
                          {timer.status === 'FIRED' && timer.firedAt
                            ? t('timers.firedAt', { date: formatDateTime(timer.firedAt, { locale }) })
                            : timer.status === 'CANCELLED'
                              ? t(timer.cancelReason && ['MOVED', 'GONE', 'RULE_OFF', 'RULE_CHANGED'].includes(timer.cancelReason) ? `timers.cancel.${timer.cancelReason}` : 'timers.cancel.other')
                              : t('timers.firesAt', { date: formatDateTime(timer.fireAt, { locale }) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        ) : (
          <p className="fw-rule-muted">{t('dialog.noKinds')}</p>
        )}
      </div>
    </Modal>
  )
}

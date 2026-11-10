'use client'

import { useMemo, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { RuleBuilder, type RuleField } from '@nexus/ui/patterns/RuleBuilder/index'
import { Button, Input, SegmentedControl, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { SaveBar } from '../../../library/parts'
import { ANY_OPTION, newRuleItem, OPTION_LIMITS, ruleItemsOf, ruleProblems, rulesChangeCount, subjectOf, type GroupRecord, type OptionRuleKind, type OptionRuleSeverity, type RuleItem } from '../../model'
import type { GroupRecordActions, GroupRecordModel, OtherValues } from '../../view-model'
import { useSay } from '../../view/parts'
import { manageHeld } from './GroupRecordView'

/**
 * Option group › Rules (design rec tab option.rules, PRD-207; explicit save with the EditModeBar): each rule is "the option
 * (or any option of the group) requires or excludes another option, as a block or a warning, with a message". The subject is
 * the design system's RuleBuilder (one condition: "the option is …"); the outcome is the rule's own controls; each rule
 * previews in words ("Full perforation excludes Thermal liner — block"). The set is saved at once at the group's version (a
 * rule left out is removed; a rule switched off is kept). Read-only: the rules as words, with the reason.
 */
export function RulesTab({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const locale = useLocale()
  const say = useSay()
  const ds = useDsWords()
  const held = manageHeld(group, model, t)
  const saved = useMemo(() => ruleItemsOf(group), [group])
  const items = model.rules.items ?? saved
  const counter = useRef(0)

  // Every option a rule may name: this group's, the saved rules' others, the other groups' read so far.
  const names = useMemo(() => {
    const map = new Map<string, { code: string; name: string; groupId: string; status: 'ACTIVE' | 'ARCHIVED' }>()
    for (const value of group.values) map.set(value.id, { code: value.code, name: value.name, groupId: group.id, status: value.status })
    for (const rule of group.rules) if (!map.has(rule.other.id)) map.set(rule.other.id, { code: rule.other.code, name: rule.other.name, groupId: rule.other.groupId, status: rule.other.status })
    for (const [groupId, values] of Object.entries(model.rules.values)) if (Array.isArray(values)) for (const value of values as OtherValues) if (!map.has(value.id)) map.set(value.id, { code: value.code, name: value.name, groupId, status: value.status })
    return map
  }, [group, model.rules.values])
  const nameOf = (valueId: string | null) => (valueId === null ? '…' : valueId === ANY_OPTION ? t('rules.any', { group: group.name }) : (names.get(valueId)?.name ?? '…'))

  const fields: RuleField[] = useMemo(
    () => [
      {
        id: 'option',
        label: t('rules.field'),
        kind: 'choice',
        operators: ['eq'],
        options: group.subjectOptions.filter((option) => option.status === 'ACTIVE' || items.some((item) => subjectOf(item) === option.value)).map((option) => ({ value: option.value, label: option.code ? `${say(option.words)} (${option.code})` : say(option.words) })),
      },
    ],
    [group.subjectOptions, items, say, t],
  )

  const problems = ruleProblems(items, group.id, (valueId) => names.get(valueId)?.groupId)
  const changes = model.rules.items ? rulesChangeCount(group, model.rules.items) : 0
  const saveHeld = held ?? (problems.length > 0 ? t('rules.held', { count: problems.length }) : null)
  const edit = (next: RuleItem[]) => actions?.onRules?.(next)
  const setItem = (key: string, patch: Partial<RuleItem>) => edit(items.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  const groups = (model.rules.groups ?? []).filter((row) => row.status === 'ACTIVE')

  const otherChoices = (item: RuleItem): Array<{ id: string; label: string; disabled: boolean }> => {
    if (!item.otherGroupId) return []
    const own = item.otherGroupId === group.id
    const list = own ? group.values.map((value) => ({ id: value.id, code: value.code, name: value.name, status: value.status })) : model.rules.values[item.otherGroupId]
    const values = Array.isArray(list) ? (list as OtherValues) : []
    const choices = values.filter((value) => value.status === 'ACTIVE' || value.id === item.otherValueId).map((value) => ({ id: value.id, label: `${value.name} (${value.code})`, disabled: value.id === subjectOf(item) }))
    // A saved rule's other option stays listed while its group's values are read.
    if (item.otherValueId && !choices.some((choice) => choice.id === item.otherValueId) && names.has(item.otherValueId)) choices.unshift({ id: item.otherValueId, label: `${names.get(item.otherValueId)!.name} (${names.get(item.otherValueId)!.code})`, disabled: false })
    return choices
  }

  if (held && items.length === 0)
    return (
      <Card padded>
        <EmptyState title={t('rules.empty.title')} description={t('rules.empty.bodyView')} />
      </Card>
    )

  if (held)
    return (
      <Card padded>
        <div className="fw-opt-cardhead">
          <h2 className="fw-lib-h3">{t('rules.title')}</h2>
          <span className="fw-lib-hint">{t('rules.viewOnly')}</span>
        </div>
        <Banner tone="info" title={t('readOnly', { reason: held })} />
        <ol className="fw-opt-rules-read">
          {group.rules.map((rule) => (
            <li key={rule.id}>
              <span className="fw-lib-strong">{say(rule.words)}</span>
              {rule.status === 'ARCHIVED' && <Tag tone="neutral">{t('rules.off')}</Tag>}
              <span className="fw-lib-sub">{t('rules.brokenSays', { words: say(rule.broken) })}</span>
            </li>
          ))}
        </ol>
      </Card>
    )

  return (
    <div className="fw-lib-stack">
      <Card padded>
        <div className="fw-opt-cardhead">
          <h2 className="fw-lib-h3">{t('rules.title')}</h2>
          <span className="fw-lib-hint">{t('rules.intro')}</span>
        </div>
        {model.rules.problem && (
          <Banner tone="danger" title={tl(model.rules.problem)}>
            {model.rules.messages.length > 0 ? model.rules.messages.join(' ') : null}
          </Banner>
        )}
        {items.length === 0 ? (
          <EmptyState title={t('rules.empty.title')} description={t('rules.empty.body')} />
        ) : (
          <ol className="fw-opt-rules">
            {items.map((item, index) => {
              const problem = problems.find((entry) => entry.index === index)
              const verb = t(item.kind === 'REQUIRES' ? 'rules.requires' : 'rules.excludes')
              const outcome = `— ${verb} ${nameOf(item.otherValueId)} (${t(item.severity === 'BLOCK' ? 'rules.block' : 'rules.warn')})`
              const otherValues = item.otherGroupId && item.otherGroupId !== group.id ? model.rules.values[item.otherGroupId] : undefined
              return (
                <li key={item.key} className="fw-opt-rule" data-off={item.active ? undefined : 'true'}>
                  <div className="fw-opt-rule-head">
                    <span className="fw-lib-strong">{t('rules.rule', { n: index + 1 })}</span>
                    {!item.active && <Tag tone="neutral">{t('rules.off')}</Tag>}
                    {!item.id && <Tag tone="info">{t('rules.new')}</Tag>}
                    <span className="fw-lib-actions">
                      <span className="fw-lib-inline">
                        <Toggle size="sm" checked={item.active} aria-label={t('rules.onOf', { n: index + 1 })} onChange={(next) => setItem(item.key, { active: next })} />
                        <span aria-hidden>{t('rules.on')}</span>
                      </span>
                      <Button size="sm" variant="quiet" aria-label={t('rules.remove', { n: index + 1 })} onClick={() => edit(items.filter((entry) => entry.key !== item.key))}>
                        <Trash2 size={13} aria-hidden /> {t('rules.removeShort')}
                      </Button>
                    </span>
                  </div>
                  <RuleBuilder
                    label={t('rules.subject')}
                    fields={fields}
                    value={item.when}
                    onChange={(when) => setItem(item.key, { when })}
                    maxRows={1}
                    lead={t('rules.lead')}
                    outcome={outcome}
                    locale={locale === 'it' ? 'it-IT' : 'en-GB'}
                    labels={ds.ruleBuilder}
                  />
                  <div className="fw-opt-rule-outcome">
                    <Field label={t('rules.kind')}>
                      <SegmentedControl
                        ariaLabel={t('rules.kind')}
                        size="sm"
                        wrap
                        value={item.kind}
                        options={[
                          { value: 'REQUIRES', label: t('rules.requires') },
                          { value: 'EXCLUDES', label: t('rules.excludes') },
                        ]}
                        onChange={(kind) => setItem(item.key, { kind: kind as OptionRuleKind })}
                      />
                    </Field>
                    <Field label={t('rules.otherGroup')}>
                      <Select
                        size="sm"
                        value={item.otherGroupId ?? ''}
                        onChange={(event) => {
                          const groupId = event.target.value || null
                          setItem(item.key, { otherGroupId: groupId, otherValueId: null })
                          if (groupId && groupId !== group.id) actions?.onOtherGroup?.(groupId)
                        }}
                      >
                        <option value="">{t('rules.pickGroup')}</option>
                        <option value={group.id}>{t('rules.thisGroup', { code: group.code })}</option>
                        {groups
                          .filter((row) => row.id !== group.id)
                          .map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.code} · {row.name}
                            </option>
                          ))}
                        {item.otherGroupId && item.otherGroupId !== group.id && !groups.some((row) => row.id === item.otherGroupId) && <option value={item.otherGroupId}>{names.get(item.otherValueId ?? '') ? t('rules.savedGroup') : '…'}</option>}
                      </Select>
                    </Field>
                    <Field label={t('rules.other')} hint={otherValues === 'loading' ? t('rules.reading') : otherValues === 'failed' ? t('rules.readFailed') : undefined}>
                      <Select size="sm" value={item.otherValueId ?? ''} aria-invalid={problem?.key === 'rules.problem.other' || problem?.key === 'rules.problem.same' ? true : undefined} onChange={(event) => setItem(item.key, { otherValueId: event.target.value || null })}>
                        <option value="">{t('rules.pickOther')}</option>
                        {otherChoices(item).map((choice) => (
                          <option key={choice.id} value={choice.id} disabled={choice.disabled}>
                            {choice.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('rules.severity')}>
                      <SegmentedControl
                        ariaLabel={t('rules.severity')}
                        size="sm"
                        wrap
                        value={item.severity}
                        options={[
                          { value: 'BLOCK', label: t('rules.block') },
                          { value: 'WARN', label: t('rules.warn') },
                        ]}
                        onChange={(severity) => setItem(item.key, { severity: severity as OptionRuleSeverity })}
                      />
                    </Field>
                  </div>
                  <div className="fw-opt-rule-messages">
                    <Field label={t('rules.messageIt')} hint={t('rules.messageHint')}>
                      <Input size="sm" lang="it" value={item.messageIt} maxLength={OPTION_LIMITS.message} onChange={(event) => setItem(item.key, { messageIt: event.target.value })} />
                    </Field>
                    <Field label={t('rules.messageEn')}>
                      <Input size="sm" lang="en" value={item.messageEn} maxLength={OPTION_LIMITS.message} onChange={(event) => setItem(item.key, { messageEn: event.target.value })} />
                    </Field>
                  </div>
                  {problem && (
                    <p className="fw-lib-danger" role="status">
                      {t(problem.key, problem.params)}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        )}
        <div className="fw-lib-actions">
          <Button
            size="sm"
            heldReason={items.length >= OPTION_LIMITS.rules ? t('rules.tooMany', { max: OPTION_LIMITS.rules }) : null}
            onClick={() => {
              counter.current += 1
              edit([...items, newRuleItem(`new-${counter.current}-${items.length}`, group.id)])
            }}
          >
            <Plus size={13} aria-hidden /> {t('rules.add')}
          </Button>
        </div>
        <p className="fw-lib-hint">{t('rules.later')}</p>
      </Card>
      {changes > 0 && <SaveBar count={changes} onDiscard={() => actions?.onRules?.(null)} onSave={() => actions?.onSaveRules?.()} held={saveHeld} busy={model.rules.busy} saveLabel={t('rules.save')} />}
    </div>
  )
}

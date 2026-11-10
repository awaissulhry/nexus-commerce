'use client'

import type { ReactNode } from 'react'
import { Card, Disclosure, SummaryTable } from '@nexus/ui/components'
import { Pill, Radio, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { auditHref, changeHeld, EDIT_KINDS, EDIT_RULES, inheritedRules, letsThrough, rulesChanged, rulesLoosenings, rulesPreview, STYLE_LIFECYCLES, type EditRule, type InForce } from '../model'
import type { ProductSettingsActions, ProductSettingsModel } from '../view-model'
import { CardDescription, CardFailed, Source, ViewOnly } from './parts'

const TONE: Readonly<Record<EditRule, 'neutral' | 'info' | 'warning' | 'danger'>> = Object.freeze({ FREE: 'neutral', NEW_REVISION: 'info', CHANGE_ORDER: 'warning', BLOCKED: 'danger' })

/** The rule in force with where it comes from ("Needs a change order · Every company"). */
function RuleInForce({ value }: { value: InForce<EditRule> | null }) {
  const t = useT('products-settings')
  if (!value) return <span className="fw-pst-sub">{t('rules.unknown')}</span>
  return (
    <span className="fw-pst-inforce">
      <Pill tone={TONE[value.rule]}>{t(`rule.${value.rule}`)}</Pill>
      <Source source={value.source} />
    </span>
  )
}

/**
 * psettings.lifecycle — Edit rules per lifecycle state (PRD-182; design "a visible table, not a status profile hidden in
 * customising"): one row per state, one radio per rule (and "Follow every company" for a company), the rule in force with
 * its source, and what each rule lets through (factory-domain's own refusal, read in a second table). EditModeBar (⌘S); a
 * rule that lets more through than today asks "Confirm a looser rule" with the reason first. A reader sees the rules in
 * force as text.
 */
export function EditRulesCard({ model, actions, shortcut }: { model: ProductSettingsModel; actions?: ProductSettingsActions; shortcut: boolean }) {
  const t = useT('products-settings')
  const settings = model.settings.value
  const tenant = model.address.scope === 'all' ? settings : model.tenant.value
  const draft = model.rules
  const held = changeHeld(settings, model.address.scope, model.busy !== null, model.live === 'offline')
  // Offline the choices stay (kept on this page); Save is held with why.
  const editable = !!settings && settings.mayChange
  const isCompany = model.address.scope === 'company'
  const problem = model.settings.problem ?? (isCompany ? model.tenant.problem : null)
  const body = (): ReactNode => {
    if (problem) return <CardFailed title={t('rules.failed')} problem={problem} onRetry={actions?.onRetry} />
    if (!settings || !draft || (isCompany && !tenant)) return <Skeleton height={320} />
    const inherited = inheritedRules(model.address.scope, settings, tenant)
    const preview = rulesPreview(model.address.scope, draft, inherited)
    const changed = rulesChanged(settings, draft)
    const loosens = rulesLoosenings(settings, draft, inherited, model.address.scope)
    const set = (state: (typeof STYLE_LIFECYCLES)[number], rule: EditRule | null) => actions?.onRules?.({ ...draft, [state]: rule })
    const disabled = model.busy !== null
    const columns = editable
      ? [t('rules.col.state'), ...EDIT_RULES.map((rule) => t(`rule.${rule}`)), ...(isCompany ? [t('rules.col.follow')] : [t('rules.col.default')]), t('rules.col.inForce')]
      : [t('rules.col.state'), t('rules.col.rule'), t('rules.col.from')]
    const rows = STYLE_LIFECYCLES.map((state) => {
      const stateWords = t(`state.${state}`)
      const name = `pst-rule-${state}`
      if (!editable) {
        const now = settings.editRules.find((entry) => entry.state === state)
        return { id: state, cells: [<strong key="s">{stateWords}</strong>, now ? <Pill key="r" tone={TONE[now.rule]}>{t(`rule.${now.rule}`)}</Pill> : '—', now ? <Source key="f" source={now.source} /> : '—'] }
      }
      const follow = inherited[state]
      return {
        id: state,
        cells: [
          <span key="s" className={changed.includes(state) ? 'fw-pst-state is-changed' : 'fw-pst-state'}>
            <strong>{stateWords}</strong>
            {changed.includes(state) && <span className="fw-pst-sub">{t('rules.changed')}</span>}
          </span>,
          ...EDIT_RULES.map((rule) => (
            <Radio key={rule} name={name} checked={draft[state] === rule} disabled={disabled} aria-label={t('rules.choose', { state: stateWords, rule: t(`rule.${rule}`) })} onChange={() => set(state, rule)} />
          )),
          <span key="follow" className="fw-pst-follow">
            <Radio
              name={name}
              checked={draft[state] === null}
              disabled={disabled}
              aria-label={follow ? t(isCompany ? 'rules.followOf' : 'rules.defaultOf', { state: stateWords, rule: t(`rule.${follow.rule}`) }) : t('rules.followUnknown', { state: stateWords })}
              onChange={() => set(state, null)}
            />
            {follow && <span className="fw-pst-sub">{t(`rule.${follow.rule}`)}</span>}
          </span>,
          <RuleInForce key="in" value={preview[state]} />,
        ],
      }
    })
    const count = changed.length
    return (
      <div className="fw-pst-stack">
        {!settings.mayChange && <p className="fw-pst-held">{t(isCompany ? 'held.noRight' : 'held.noRightAll')}</p>}
        {settings.mayChange && model.live === 'offline' && <p className="fw-pst-held">{t('held.offline')}</p>}
        <div className="fw-pst-table">
          <SummaryTable label={t('rules.table')} columns={columns} rows={rows} stackOnPhone align={columns.map(() => 'left' as const)} widths={editable ? ['14%', '11%', '13%', '13%', '10%', '17%', '22%'] : ['30%', '40%', '30%']} />
        </div>
        <p className="fw-pst-hint">{t(isCompany ? 'rules.companyHint' : 'rules.allHint')}</p>
        <Disclosure summary={t('lets.title')}>
          <div className="fw-pst-stack">
            <p className="fw-pst-hint">{t('lets.intro')}</p>
            <div className="fw-pst-table">
              <SummaryTable
                label={t('lets.title')}
                columns={[t('lets.col.write'), ...EDIT_RULES.map((rule) => t(`rule.${rule}`))]}
                align={[undefined, 'left', 'left', 'left', 'left']}
                stackOnPhone
                rows={EDIT_KINDS.map((kind) => ({
                  id: kind,
                  cells: [
                    <span key="k" className="fw-pst-cell">
                      <strong>{t(`kind.${kind}`)}</strong>
                      <span className="fw-pst-sub">{t(`kindHint.${kind}`)}</span>
                    </span>,
                    ...EDIT_RULES.map((rule) => <span key={rule}>{t(`lets.${letsThrough(rule, kind)}`)}</span>),
                  ],
                }))}
              />
            </div>
          </div>
        </Disclosure>
        {count > 0 && loosens.length > 0 && <p className="fw-pst-warn">{t('rules.loosens', { count: loosens.length })}</p>}
        {count > 0 && (
          <EditModeBar
            count={count}
            busy={model.busy === 'rules'}
            applyHeldReason={held && held !== 'held.busy' ? t(held) : null}
            applyLabel={loosens.length > 0 ? t('rules.applyLoosen') : t('rules.apply')}
            onDiscard={() => actions?.onDiscardRules?.()}
            onApply={() => actions?.onApplyRules?.()}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }
  return (
    <Card
      header={t('rules.title')}
      description={
        <CardDescription
          text={t('rules.description')}
          changed={model.changed.rules}
          href={model.can.audit && settings?.exists && model.rowId ? auditHref(model.prefix, 'ProductSettings', model.rowId) : null}
        />
      }
      headerAction={settings && !editable ? <ViewOnly reason={t(held ?? 'held.noRight')} /> : undefined}
      headingLevel={2}
      className="fw-pst-card"
    >
      {body()}
    </Card>
  )
}

'use client'

import type { ReactElement } from 'react'
import { ArrowDown, ArrowUp, Info, Pencil, Plus, Undo2 } from 'lucide-react'
import { Banner, DetailPopover } from '@nexus/ui/components'
import { Button, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { TeamChip } from '../../../../lib/people-picture/view/TeamChip'
import { Quiet, Section } from '../../../../lib/record-sections/Kit'
import type { RuleRow, RulesRead, StructureRow, TryAnswer } from '../api'
import { CATEGORIES, headOf, ORDER_STRUCTURES_NS, ruleMarkOf, ruleNoOf, rulesOf, type Words } from '../model'
import { RuleSentence } from './RuleSentence'
import '../order-structures.css'

/**
 * owb-ss8 (8.3; design § 5zj C; prototype rules.js rulesPage) — Production › Order structures: the RULES (one sentence each, read from
 * the top, the first that fits wins; arrows move a rule; "Never used" with one press "Move it up"; the fixed last line "Everything else →
 * the normal way"; the never-used count in the head), "Try an order" (a customer and a category → the rule that wins and why each other
 * does not), and the STRUCTURES (name, teams, office people, used by n rules, closed and kept). Sales writes rules, the production manager
 * structures (by `may`). Draws one model; fetches nothing.
 */

export interface OrderStructuresViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  readonly structures: readonly StructureRow[] | null
  readonly rules: RulesRead | null
  readonly may: { readonly manage: boolean; readonly write: boolean }
  /** The customers Try offers (null: not read). */
  readonly customers: readonly { readonly id: string; readonly name: string }[] | null
  readonly tryTerms: { readonly partyId: string | null; readonly category: string | null }
  readonly tryAnswer: { readonly value: TryAnswer | null; readonly reading: boolean; readonly problem: string | null }
  /** A rule being moved (its arrows wait). */
  readonly moving: string | null
  readonly notice: Words | null
}

export interface OrderStructuresViewActions {
  readonly onRetry: () => void
  readonly onNewRule: () => void
  readonly onEditRule: (rule: RuleRow) => void
  readonly onUp: (rule: RuleRow) => void
  readonly onDown: (rule: RuleRow) => void
  readonly onAbove: (rule: RuleRow) => void
  readonly onReopenRule: (rule: RuleRow) => void
  readonly onNewStructure: () => void
  readonly onOpenStructure: (row: StructureRow) => void
  readonly onReopenStructure: (row: StructureRow) => void
  readonly onTryParty: (partyId: string | null) => void
  readonly onTryCategory: (category: string | null) => void
  readonly onDismissNotice: () => void
}

export function OrderStructuresView({ model, actions }: { model: OrderStructuresViewModel; actions?: OrderStructuresViewActions }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const ready = model.state === 'ready' && model.structures && model.rules
  const head = ready ? headOf(model.structures!, model.rules!.rules, model.rules!.neverUsed) : null
  return (
    <div className="fw-os">
      <div className="fw-os-head">
        <p className="fw-os-sum" role="status">
          {head ? `${t('head.structures', { count: head.structures })} · ${t('head.rules', { count: head.rules })}` : null}
          {head && head.neverUsed > 0 ? (
            <>
              {' '}
              <Tag tone="warning">{t('head.neverUsed', { count: head.neverUsed })}</Tag>
            </>
          ) : null}
        </p>
        <span className="fw-os-acts">
          {model.may.write ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewRule()}>
              <Plus size={14} aria-hidden />
              {t('head.newRule')}
            </Button>
          ) : null}
          <DetailPopover trigger={<Info size={16} aria-hidden />} triggerLabel={t('head.infoLabel')} triggerClassName="nds-btn icon" label={t('head.infoLabel')} hoverDelay={0}>
            <p className="fw-os-info">{t('head.info')}</p>
          </DetailPopover>
        </span>
      </div>
      {model.notice ? (
        <Banner
          tone={model.notice.key.startsWith('error.') ? 'danger' : 'success'}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice()}>
              {t('notice.dismiss')}
            </Button>
          }
        />
      ) : null}
      {model.state === 'reading' ? (
        <div className="fw-os-skel" aria-busy="true">
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      ) : !ready ? (
        <Banner
          tone="danger"
          title={t('failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : (
        <>
          <RulesSection model={model} actions={actions} />
          <div className="fw-os-two">
            <TrySection model={model} actions={actions} />
            <Section id="how" title={t('how.title')}>
              <ol className="fw-os-how">
                <li>{t('how.structure')}</li>
                <li>{t('how.rule')}</li>
                <li>{t('how.order')}</li>
              </ol>
              <Quiet>{t('how.kept')}</Quiet>
            </Section>
          </div>
          <StructuresSection model={model} actions={actions} />
        </>
      )}
    </div>
  )
}

function RulesSection({ model, actions }: { model: OrderStructuresViewModel; actions?: OrderStructuresViewActions }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const { open } = rulesOf(model.rules!.rules)
  return (
    <Section id="rules" title={t('rules.title')} answer={t('rules.answer')}>
      <ol className="fw-os-rules">
        {open.map((rule, index) => {
          const mark = ruleMarkOf(open, rule)
          const held = model.moving !== null ? t('rules.moving') : null
          return (
            <li key={rule.id} className={`fw-os-rule${mark.kind !== 'fits' ? ' is-dead' : ''}${rule.active ? '' : ' is-off'}`}>
              <span className="fw-os-no">{index + 1}</span>
              <span className="fw-os-rule-t">
                <RuleSentence rule={rule} />
                {rule.note ? <span className="fw-os-sub">{rule.note}</span> : null}
              </span>
              <span className="fw-os-rule-m">
                {mark.kind === 'closedStructure' ? <Tag tone="warning">{t('rules.closedStructure')}</Tag> : mark.kind === 'dead' ? <Tag tone="warning">{t('rules.neverUsed')}</Tag> : <Tag tone={mark.count ? 'success' : 'neutral'}>{t('rules.fits', { count: mark.count })}</Tag>}
              </span>
              {model.may.write ? (
                <span className="fw-os-rule-acts">
                  <Button size="xs" variant="quiet" className="icon" aria-label={t('rules.up', { n: index + 1 })} title={t('rules.upHint')} heldReason={index === 0 ? t('rules.first') : held} onClick={() => actions?.onUp(rule)}>
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                  <Button size="xs" variant="quiet" className="icon" aria-label={t('rules.down', { n: index + 1 })} title={t('rules.downHint')} heldReason={index === open.length - 1 ? t('rules.last') : held} onClick={() => actions?.onDown(rule)}>
                    <ArrowDown size={14} aria-hidden />
                  </Button>
                  <Button size="xs" variant="quiet" className="icon" aria-label={t('rules.edit', { n: index + 1 })} title={t('rules.edit', { n: index + 1 })} onClick={() => actions?.onEditRule(rule)}>
                    <Pencil size={14} aria-hidden />
                  </Button>
                </span>
              ) : null}
              {mark.kind === 'dead' ? (
                <span className="fw-os-rule-note">
                  {mark.above > 0 ? t('rules.deadBecause', { n: mark.above }) : t('rules.dead')}
                  {model.may.write && rule.deadBecause ? (
                    <Button size="xs" onClick={() => actions?.onAbove(rule)} heldReason={held}>
                      {t('rules.moveUp', { n: mark.above })}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          )
        })}
        <li className="fw-os-rule is-last">
          <span className="fw-os-no" aria-hidden>
            …
          </span>
          <span className="fw-os-rule-t">
            <span className="fw-os-sent">
              <Tag tone="neutral">{t('rules.everythingElse')}</Tag>
              <b className="fw-os-sent-s">{t('rules.normalWay')}</b>
            </span>
            <span className="fw-os-sub">{t('rules.normalWayHint')}</span>
          </span>
          <span className="fw-os-sub">{t('rules.alwaysLast')}</span>
        </li>
      </ol>
      {model.may.write ? null : <Quiet>{t('rules.readOnly')}</Quiet>}
    </Section>
  )
}

function TrySection({ model, actions }: { model: OrderStructuresViewModel; actions?: OrderStructuresViewActions }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const { open } = rulesOf(model.rules!.rules)
  const answer = model.tryAnswer.value
  return (
    <Section id="try" title={t('try.title')} answer={t('try.answer')}>
      <div className="fw-os-try">
        <label className="fw-os-field">
          <span>{t('try.customer')}</span>
          <Select size="sm" value={model.tryTerms.partyId ?? ''} onChange={(event) => actions?.onTryParty(event.target.value || null)}>
            <option value="">{t('rule.anyCustomer')}</option>
            {(model.customers ?? []).map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fw-os-field">
          <span>{t('try.category')}</span>
          <Select size="sm" value={model.tryTerms.category ?? ''} onChange={(event) => actions?.onTryCategory(event.target.value || null)}>
            <option value="">{t('rule.anyCategory')}</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {model.tryAnswer.reading ? (
        <Skeleton height={40} />
      ) : model.tryAnswer.problem ? (
        <Quiet>{t(model.tryAnswer.problem)}</Quiet>
      ) : answer ? (
        <div className="fw-os-try-res" role="status">
          <Banner tone={answer.winner.ruleId ? 'success' : 'info'} title={answer.winner.ruleId ? t('try.wins', { n: ruleNoOf(open, answer.winner.ruleId) }) : t('try.noRule')}>
            {answer.winner.words}
          </Banner>
          {answer.others.length ? (
            <ul className="fw-os-trace">
              {answer.others.map((other) => (
                <li key={other.ruleId}>
                  <span className="fw-os-no">{ruleNoOf(open, other.ruleId) || '–'}</span>
                  <span className="fw-os-sub">{other.words}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

function StructuresSection({ model, actions }: { model: OrderStructuresViewModel; actions?: OrderStructuresViewActions }): ReactElement {
  const t = useT(ORDER_STRUCTURES_NS)
  const rows = model.structures!
  const open = rows.filter((row) => !row.closed)
  const closed = rows.filter((row) => row.closed)
  const closedRules = rulesOf(model.rules!.rules).closed
  return (
    <Section
      id="structures"
      title={t('structures.title')}
      answer={t('structures.answer')}
      buttons={model.may.manage ? [<Button key="new" size="sm" onClick={() => actions?.onNewStructure()}><Plus size={14} aria-hidden />{t('structures.new')}</Button>] : []}
    >
      {open.length === 0 ? (
        <Quiet>{t('structures.none')}</Quiet>
      ) : (
        <ul className="fw-os-cards">
          {open.map((row) => (
            <li key={row.id}>
              <button type="button" className="fw-os-card" onClick={() => actions?.onOpenStructure(row)}>
                <span className="fw-os-card-name">{row.name}</span>
                <span className="fw-os-sub">{t('structures.steps')}</span>
                <span className="fw-os-chips">
                  {row.teams.length ? row.teams.map((team) => <TeamChip key={team.id} team={sourceOfPicture(team.name, team.picture, 'team')} />) : <span className="fw-os-sub">{t('structures.noTeam')}</span>}
                </span>
                {row.people.length ? <span className="fw-os-sub">{row.people.map((person) => person.name).join(' · ')}</span> : null}
                <span className="fw-os-sub">{row.usedByRules ? t('structures.used', { count: row.usedByRules }) : t('structures.unused')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {model.may.manage ? null : <Quiet>{t('structures.readOnly')}</Quiet>}
      {closed.length || closedRules.length ? (
        <div className="fw-os-closed">
          <h3 className="fw-os-h3">{t('structures.closed')}</h3>
          <ul className="fw-os-list">
            {closed.map((row) => (
              <li key={row.id}>
                <span>{row.name}</span>
                {model.may.manage ? (
                  <Button size="xs" onClick={() => actions?.onReopenStructure(row)}>
                    <Undo2 size={14} aria-hidden />
                    {t('structures.reopen')}
                  </Button>
                ) : null}
              </li>
            ))}
            {closedRules.map((rule) => (
              <li key={rule.id}>
                <RuleSentence rule={rule} />
                {model.may.write ? (
                  <Button size="xs" onClick={() => actions?.onReopenRule(rule)}>
                    <Undo2 size={14} aria-hidden />
                    {t('structures.reopen')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}

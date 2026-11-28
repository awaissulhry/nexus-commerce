'use client'

import type { ReactElement } from 'react'
import { Copy, ListPlus, Lock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { TeamChip } from '../../../../lib/people-picture/view/TeamChip'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import type { ApiPicture } from '../../../../lib/people-picture/schema'
import type { OrderStructure, RuleRow, StructureRow } from '../api'
import {
  CATEGORIES,
  FROM_TONE,
  fromWordsOf,
  ORDER_STRUCTURES_NS,
  ORDER_WHY_MAX,
  RULE_NOTE_MAX,
  STRUCTURE_NAME_MAX,
  STRUCTURE_NOTE_MAX,
  teamsNoteOf,
  type OrderDraft,
  type RuleDraft,
  type StructureDraft,
  type Words,
} from '../model'
import '../order-structures.css'

/**
 * owb-ss8 (8.3 + 8.4; design § 5zj C; prototype rules.js planModal, ruleModal, oplanModal) — the windows of Order structures, on the
 * window shell: one STRUCTURE (its name, its team(s) — the first in charge when several work together —, its office people, a note; read
 * only for whoever may not change it), one RULE (the sentence as three choices; "It fits now: n open orders"; where a new rule goes; two
 * rules for the same orders are refused), and ANOTHER STRUCTURE FOR THIS ORDER (how the rules read it, then a structure or the normal way,
 * with why). They draw; they fetch nothing.
 */

const said = (t: (key: string, params?: Words['params']) => string, words: Words | null): string | null => (words ? t(words.key, words.params) : null)

// ── one structure ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StructureWindowModel {
  readonly open: boolean
  readonly draft: StructureDraft | null
  /** The structure as read (null: a new one). */
  readonly row: StructureRow | null
  /** The teams it may name (the board's); null: not read. */
  readonly teams: readonly { readonly id: string; readonly name: string; readonly picture: ApiPicture }[] | null
  /** The office people it may name; null: not read. */
  readonly people: readonly { readonly id: string; readonly name: string }[] | null
  readonly manage: boolean
  readonly write: boolean
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface StructureWindowActions {
  readonly onClose: () => void
  readonly onName: (text: string) => void
  readonly onNote: (text: string) => void
  readonly onTeam: (teamId: string) => void
  readonly onPerson: (userId: string) => void
  readonly onSave: () => void
  readonly onCloseStructure: () => void
  readonly onCopy: () => void
  readonly onNewRule: () => void
}

export function StructureWindow({ model, actions }: { model: StructureWindowModel; actions: StructureWindowActions }): ReactElement | null {
  const t = useT(ORDER_STRUCTURES_NS)
  const draft = model.draft
  if (!draft) return null
  const row = model.row
  const more = (
    <>
      {row && model.manage ? (
        <>
          <Button size="sm" variant="quiet" onClick={actions.onCloseStructure}>
            <Lock size={14} aria-hidden />
            {t('structure.close')}
          </Button>
          <Button size="sm" variant="quiet" onClick={actions.onCopy}>
            <Copy size={14} aria-hidden />
            {t('structure.copy')}
          </Button>
        </>
      ) : null}
      {row && model.write ? (
        <Button size="sm" variant="quiet" onClick={actions.onNewRule}>
          <ListPlus size={14} aria-hidden />
          {t('structure.newRule')}
        </Button>
      ) : null}
    </>
  )
  const teamsById = new Map((model.teams ?? []).map((team) => [team.id, team]))
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={row ? t('structure.title', { name: row.name }) : t('structure.newTitle')}
      size="lg"
      act={model.manage ? { words: t(row ? 'structure.save' : 'structure.add'), onAct: actions.onSave, held: said(t, model.held), busy: model.busy } : null}
      more={row && (model.manage || model.write) ? more : undefined}
    >
      {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      {model.manage ? null : <Banner tone="info">{t('structure.readOnly')}</Banner>}
      {model.manage ? (
        <Field label={t('structure.name')}>
          <Input size="sm" value={draft.name} maxLength={STRUCTURE_NAME_MAX} placeholder={t('structure.nameHint')} onChange={(event) => actions.onName(event.target.value)} />
        </Field>
      ) : null}
      <div className="fw-os-part">
        <span className="fw-os-label">{t('structure.steps')}</span>
        <span className="fw-os-sub">{t('structure.stepsHint')}</span>
      </div>
      <div className="fw-os-part">
        <span className="fw-os-label">{t('structure.teamsLabel')}</span>
        {model.manage ? (
          <div className="fw-os-pills" role="group" aria-label={t('structure.teamsLabel')}>
            {(model.teams ?? []).map((team) => {
              const on = draft.teamIds.includes(team.id)
              return (
                <Button key={team.id} size="sm" active={on} aria-pressed={on} onClick={() => actions.onTeam(team.id)}>
                  <PeoplePicture source={sourceOfPicture(team.name, team.picture, 'team')} size="sm" nameBeside />
                  {team.name}
                  {on && draft.teamIds[0] === team.id && draft.teamIds.length > 1 ? <Tag tone="info">{t('structure.inCharge')}</Tag> : null}
                </Button>
              )
            })}
            {model.teams === null ? <span className="fw-os-sub">{t('structure.teamsUnread')}</span> : null}
          </div>
        ) : (
          <span className="fw-os-chips">
            {row?.teams.length ? row.teams.map((team) => <TeamChip key={team.id} team={sourceOfPicture(team.name, teamsById.get(team.id)?.picture ?? team.picture, 'team')} />) : <span className="fw-os-sub">{t('structures.noTeam')}</span>}
          </span>
        )}
        <span className="fw-os-sub">{t(teamsNoteOf(draft).key)}</span>
      </div>
      <div className="fw-os-part">
        <span className="fw-os-label">{t('structure.peopleLabel')}</span>
        {model.manage ? (
          <div className="fw-os-pills" role="group" aria-label={t('structure.peopleLabel')}>
            {(model.people ?? []).map((person) => {
              const on = draft.peopleIds.includes(person.id)
              return (
                <Button key={person.id} size="sm" active={on} aria-pressed={on} onClick={() => actions.onPerson(person.id)}>
                  {person.name}
                </Button>
              )
            })}
            {model.people === null ? <span className="fw-os-sub">{t('structure.peopleUnread')}</span> : null}
          </div>
        ) : (
          <span className="fw-os-sub">{row?.people.length ? row.people.map((person) => person.name).join(' · ') : '—'}</span>
        )}
        <span className="fw-os-sub">{t('structure.peopleHint')}</span>
      </div>
      {model.manage ? (
        <Field label={t('structure.note')}>
          <Input size="sm" value={draft.note} maxLength={STRUCTURE_NOTE_MAX} placeholder={t('structure.noteHint')} onChange={(event) => actions.onNote(event.target.value)} />
        </Field>
      ) : row?.note ? (
        <p className="fw-os-sub">{row.note}</p>
      ) : null}
      {row ? <p className="fw-os-sub">{row.usedByRules ? t('structures.used', { count: row.usedByRules }) : t('structures.unused')} · {t('structure.keptNote')}</p> : null}
    </WindowShell>
  )
}

// ── one rule ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleWindowModel {
  readonly open: boolean
  readonly draft: RuleDraft | null
  readonly rule: RuleRow | null
  readonly ruleNo: number
  readonly structures: readonly StructureRow[]
  readonly customers: readonly { readonly id: string; readonly name: string }[] | null
  /** Where a new rule goes (1-based) and how many open rules there are. */
  readonly place: number
  readonly total: number
  readonly manageStructures: boolean
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface RuleWindowActions {
  readonly onClose: () => void
  readonly onParty: (partyId: string | null) => void
  readonly onCategory: (category: string | null) => void
  readonly onStructure: (structureId: string | null) => void
  readonly onNote: (text: string) => void
  readonly onSave: () => void
  readonly onCloseRule: () => void
}

export function RuleWindow({ model, actions }: { model: RuleWindowModel; actions: RuleWindowActions }): ReactElement | null {
  const t = useT(ORDER_STRUCTURES_NS)
  const draft = model.draft
  if (!draft) return null
  const open = model.structures.filter((row) => !row.closed)
  const chosen = model.structures.find((row) => row.id === draft.structureId) ?? null
  const customers = model.customers ?? []
  const known = draft.partyId === null || customers.some((party) => party.id === draft.partyId)
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={model.rule ? t('rule.title', { n: model.ruleNo }) : t('rule.newTitle')}
      size="lg"
      act={{ words: t(model.rule ? 'rule.save' : 'rule.add'), onAct: actions.onSave, held: said(t, model.held), busy: model.busy }}
      more={model.rule ? <Button size="sm" variant="quiet" onClick={actions.onCloseRule}><Lock size={14} aria-hidden />{t('rule.close')}</Button> : undefined}
    >
      {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      <div className="fw-os-form">
        <label className="fw-os-field">
          <span>{t('rule.whenCustomer')}</span>
          <Select size="sm" value={draft.partyId ?? ''} onChange={(event) => actions.onParty(event.target.value || null)}>
            <option value="">{t('rule.anyCustomer')}</option>
            {known ? null : <option value={draft.partyId ?? ''}>{model.rule?.party?.name ?? t('rule.thisCustomer')}</option>}
            {customers.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fw-os-field">
          <span>{t('rule.andIsCategory')}</span>
          <Select size="sm" value={draft.category ?? ''} onChange={(event) => actions.onCategory(event.target.value || null)}>
            <option value="">{t('rule.anyCategory')}</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className="fw-os-field">
          <span>{t('rule.handleAs')}</span>
          <Select size="sm" value={draft.structureId ?? ''} onChange={(event) => actions.onStructure(event.target.value || null)}>
            <option value="">{t('rule.pickStructure')}</option>
            {open.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {chosen ? null : <Banner tone="warning" title={t('rule.chooseStructure')}>{t(model.manageStructures ? 'rule.makeOneFirst' : 'rule.managerMakes')}</Banner>}
      <div className="fw-os-preview">
        <span className="fw-os-label">{t('rule.doesNow')}</span>
        {model.rule ? (
          <span className="fw-os-sub">
            {model.rule.fitsNow.count
              ? t('rule.fitsNow', { count: model.rule.fitsNow.count, orders: model.rule.fitsNow.orders.map((order) => order.number).join(', ') })
              : t('rule.fitsNone')}
          </span>
        ) : (
          <span className="fw-os-sub">{model.place > model.total ? t('rule.placeLast', { n: model.place }) : t('rule.place', { n: model.place })}</span>
        )}
        <span className="fw-os-sub">{t('rule.keptNote')}</span>
      </div>
      <Field label={t('rule.note')}>
        <Input size="sm" value={draft.note} maxLength={RULE_NOTE_MAX} placeholder={t('rule.noteHint')} onChange={(event) => actions.onNote(event.target.value)} />
      </Field>
    </WindowShell>
  )
}

// ── another structure for this order ─────────────────────────────────────────────────────────────────────────────────────────

export interface OrderWindowModel {
  readonly open: boolean
  readonly read: OrderStructure | null
  readonly draft: OrderDraft | null
  readonly structures: readonly StructureRow[] | null
  readonly ruleNo: (ruleId: string) => number
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface OrderWindowActions {
  readonly onClose: () => void
  readonly onPick: (structureId: string | null) => void
  readonly onWhy: (text: string) => void
  readonly onSave: () => void
}

export function OrderStructureWindow({ model, actions }: { model: OrderWindowModel; actions: OrderWindowActions }): ReactElement | null {
  const t = useT(ORDER_STRUCTURES_NS)
  const read = model.read
  const draft = model.draft
  if (!read || !draft) return null
  const open = (model.structures ?? []).filter((row) => !row.closed)
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('order.windowTitle')} size="lg" act={{ words: t('order.use'), onAct: actions.onSave, held: said(t, model.held), busy: model.busy }}>
      {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      <span className="fw-os-label">{t('order.howRead')}</span>
      <ul className="fw-os-lines">
        {read.lines.map((line) => {
          const from = fromWordsOf(line, line.rule ? model.ruleNo(line.rule.id) : 0)
          return (
            <li key={line.salesOrderLineId}>
              <span className="fw-os-line-l">{line.label}</span>
              <span className="fw-os-sub">{line.structure?.name ?? t('rules.normalWay')}</span>
              <Tag tone={FROM_TONE[line.from]}>{t(from.key, from.params)}</Tag>
            </li>
          )
        })}
      </ul>
      <fieldset className="fw-os-fieldset">
        <legend className="fw-os-label">{t('order.byHand')}</legend>
        {open.map((row) => (
          <RadioCard key={row.id} name="fw-os-order" value={row.id} checked={draft.structureId === row.id} selected={draft.structureId === row.id} onChange={() => actions.onPick(row.id)} title={row.name} description={row.teams.map((team) => team.name).join(' + ') || t('structures.noTeam')} />
        ))}
        <RadioCard name="fw-os-order" value="" checked={draft.structureId === null} selected={draft.structureId === null} onChange={() => actions.onPick(null)} title={t('rules.normalWay')} description={t('rules.normalWayHint')} />
      </fieldset>
      <Field label={t('order.why')}>
        <Input size="sm" value={draft.why} maxLength={ORDER_WHY_MAX} placeholder={t('order.whyHint')} onChange={(event) => actions.onWhy(event.target.value)} />
      </Field>
    </WindowShell>
  )
}

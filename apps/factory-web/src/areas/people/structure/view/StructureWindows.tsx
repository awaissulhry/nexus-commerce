'use client'

import type { ReactElement } from 'react'
import { ArrowRightLeft, Check, Flag, Network, Search } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, SegmentedControl, Skeleton, Toggle } from '@nexus/ui/primitives'
import { DateField } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import { READY_MADE, type ReadyMade, type ReadyMadePreview, type UnitRecord } from '../api'
import {
  ABOUT_MAX,
  filterUnits,
  KIND_MAX,
  KIND_WORDS,
  mergeHeldOf,
  mergeIdsOf,
  NAME_MAX,
  PHONE_MAX,
  ROLE_MAX,
  SPEAKS,
  STRUCTURE_NS,
  type AddDraft,
  type Drag,
  type MergeDraft,
  type MoveAsk,
  type PersonDraft,
  type Tree,
  type UnitDraft,
  type UnitNode,
  type Words,
} from '../model'
import { PicturePicker } from './PicturePicker'
import '../structure.css'

/**
 * owb-ss8 (8.2; design § 5zd "every window has the same build": a picture and a title on top, the body scrolls, Cancel and the main
 * button stay at the bottom, on a phone it comes from the bottom; prototype org.js orgModal) — the windows of People › Factory structure,
 * all on the window shell: Edit the profile / A new unit (two columns WHO IT IS · HOW IT WORKS, and YOUR OWN FACTS), Move (a search on
 * top, then it asks), Merge (tick ≥ 1, then which profile stays, the name, the leader; it says what moves), Close (what to move first),
 * Ready-made (3 choices + what changes), Edit the person, Add a person. No figure about one person's work. They draw; they fetch nothing.
 */

const said = (t: (key: string, params?: Words['params']) => string, words: Words | null): string | null => (words ? t(words.key, words.params) : null)

function Problem({ problem }: { problem: string | null }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  return problem ? <Banner tone="danger" title={t(problem)} /> : null
}

// ── Edit the profile · A new unit ────────────────────────────────────────────────────────────────────────────────────────────

export interface UnitWindowModel {
  readonly open: boolean
  readonly draft: UnitDraft | null
  /** The unit as read (its people for the leader and the stand-in, its own facts); null for a new unit. */
  readonly record: UnitRecord | null
  /** "Under …" of a new unit. */
  readonly parentName: string | null
  /** The customers "Works for" offers (null: not read). */
  readonly customers: readonly { readonly id: string; readonly name: string }[] | null
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface UnitWindowActions {
  readonly onClose: () => void
  readonly onTeam: (team: boolean) => void
  readonly onName: (text: string) => void
  readonly onKind: (text: string) => void
  readonly onAbout: (text: string) => void
  readonly onLetters: () => void
  readonly onIcon: (icon: string) => void
  readonly onColour: (colour: string) => void
  readonly onLeader: (employeeId: string | null) => void
  readonly onStandIn: (employeeId: string | null) => void
  readonly onStandInUntil: (day: string) => void
  readonly onWorksFor: (partyId: string | null) => void
  readonly onMax: (text: string) => void
  readonly onTakesNew: (takes: boolean) => void
  readonly onSave: () => void
}

export function UnitWindow({ model, actions }: { model: UnitWindowModel; actions: UnitWindowActions }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  const draft = model.draft
  if (!draft) return null
  const isNew = draft.id === null
  const members = model.record?.members ?? []
  const standIns = members.filter((row) => row.employeeId !== draft.leaderId)
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={t(isNew ? 'unit.newTitle' : 'unit.editTitle')}
      subtitle={isNew ? t('unit.underName', { unit: model.parentName ?? t('glance.top') }) : draft.name}
      size="xl"
      act={{ words: t(isNew ? 'unit.make' : 'unit.save'), onAct: actions.onSave, held: said(t, model.held), busy: model.busy }}
    >
      <Problem problem={model.problem} />
      {isNew ? (
        <div className="fw-fs-choice" role="group" aria-label={t('unit.whatItIs')}>
          <Button active={draft.takesOrders} aria-pressed={draft.takesOrders} onClick={() => actions.onTeam(true)}>
            <Flag size={14} aria-hidden />
            {t('unit.isTeam')}
          </Button>
          <Button active={!draft.takesOrders} aria-pressed={!draft.takesOrders} onClick={() => actions.onTeam(false)}>
            <Network size={14} aria-hidden />
            {t('unit.isUnit')}
          </Button>
        </div>
      ) : null}
      <div className="fw-fs-cols">
        <section className="fw-fs-col" aria-label={t('unit.whoItIs')}>
          <h3 className="fw-fs-h3">{t('unit.whoItIs')}</h3>
          <div className="fw-fs-who">
            <PeoplePicture source={{ name: draft.name.trim() || t('unit.newName'), who: 'team', kind: draft.picture.kind, icon: draft.picture.icon, colour: draft.picture.colour }} size="lg" nameBeside />
            <span className="fw-fs-grow">
              <Field label={t('unit.name')}>
                <Input size="sm" value={draft.name} maxLength={NAME_MAX} placeholder={t(draft.takesOrders ? 'unit.nameTeamHint' : 'unit.nameUnitHint')} onChange={(event) => actions.onName(event.target.value)} />
              </Field>
            </span>
          </div>
          {draft.takesOrders ? null : (
            <Field label={t('unit.kind')} hint={t('unit.kindHint')}>
              <Input size="sm" list="fw-fs-kinds" value={draft.kindWord} maxLength={KIND_MAX} onChange={(event) => actions.onKind(event.target.value)} />
            </Field>
          )}
          <datalist id="fw-fs-kinds">
            {KIND_WORDS.map((kind) => (
              <option key={kind} value={t(`kind.${kind}`)} />
            ))}
          </datalist>
          <span className="fw-fs-label">{t('unit.picture')}</span>
          <PicturePicker name={draft.name} picture={draft.picture} onLetters={actions.onLetters} onIcon={actions.onIcon} onColour={actions.onColour} />
          <Field label={t('unit.about')}>
            <Input size="sm" value={draft.about} maxLength={ABOUT_MAX} placeholder={t('unit.aboutHint')} onChange={(event) => actions.onAbout(event.target.value)} />
          </Field>
        </section>
        <section className="fw-fs-col" aria-label={t('unit.howItWorks')}>
          <h3 className="fw-fs-h3">{t('unit.howItWorks')}</h3>
          {isNew ? (
            <p className="fw-fs-quiet">{t('unit.leaderLater')}</p>
          ) : (
            <>
              <span className="fw-fs-label">{t('unit.leaderLabel')}</span>
              <div className="fw-fs-pills" role="group" aria-label={t('unit.leaderLabel')}>
                {members.map((row) => (
                  <Button key={row.employeeId} size="sm" active={draft.leaderId === row.employeeId} aria-pressed={draft.leaderId === row.employeeId} onClick={() => actions.onLeader(row.employeeId)}>
                    {row.name}
                  </Button>
                ))}
                <Button size="sm" active={draft.leaderId === null} aria-pressed={draft.leaderId === null} onClick={() => actions.onLeader(null)}>
                  {t('unit.nobody')}
                </Button>
              </div>
              {members.length === 0 ? <p className="fw-fs-quiet">{t('unit.addPeopleFirst')}</p> : null}
              <span className="fw-fs-label">{t('unit.standIn')}</span>
              <div className="fw-fs-pills" role="group" aria-label={t('unit.standIn')}>
                {standIns.map((row) => (
                  <Button key={row.employeeId} size="sm" active={draft.standInId === row.employeeId} aria-pressed={draft.standInId === row.employeeId} onClick={() => actions.onStandIn(row.employeeId)}>
                    {row.name}
                  </Button>
                ))}
                <Button size="sm" active={draft.standInId === null} aria-pressed={draft.standInId === null} onClick={() => actions.onStandIn(null)}>
                  {t('unit.nobody')}
                </Button>
              </div>
              {draft.standInId ? (
                <div className="fw-fs-field">
                  <span className="fw-fs-label" aria-hidden>
                    {t('unit.standInUntil')}
                  </span>
                  <DateField value={draft.standInUntil} onChange={actions.onStandInUntil} ariaLabel={t('unit.standInUntil')} clearable />
                </div>
              ) : null}
            </>
          )}
          {draft.takesOrders || draft.worksFor.length > 0 ? (
            <>
              <span className="fw-fs-label">{t('unit.worksFor')}</span>
              <div className="fw-fs-pills" role="group" aria-label={t('unit.worksFor')}>
                <Button size="sm" active={draft.worksFor.length === 0} aria-pressed={draft.worksFor.length === 0} onClick={() => actions.onWorksFor(null)}>
                  {t('glance.allCustomers')}
                </Button>
                {(model.customers ?? []).map((party) => (
                  <Button key={party.id} size="sm" active={draft.worksFor.includes(party.id)} aria-pressed={draft.worksFor.includes(party.id)} onClick={() => actions.onWorksFor(party.id)}>
                    {party.name}
                  </Button>
                ))}
              </div>
              <p className="fw-fs-quiet">{t('unit.worksForHint')}</p>
            </>
          ) : null}
          {draft.takesOrders ? (
            <>
              <Field label={t('unit.max')} hint={t('unit.maxHint')}>
                <Input size="sm" inputMode="numeric" value={draft.maxBaskets} maxLength={3} placeholder={t('unit.noLimit')} onChange={(event) => actions.onMax(event.target.value)} />
              </Field>
              <label className="fw-fs-toggle">
                <Toggle checked={draft.takesNewOrders} onChange={(next) => actions.onTakesNew(next)} />
                <span>{t(draft.takesNewOrders ? 'unit.takesNew' : 'unit.takesNoNew')}</span>
              </label>
            </>
          ) : null}
          {isNew ? null : (
            <>
              <h3 className="fw-fs-h3">{t('unit.ownFacts')}</h3>
              {model.record && model.record.ownFacts.length > 0 ? <KeyValue dense labelCase="sentence" items={model.record.ownFacts.map((fact) => ({ label: fact.label || '—', value: fact.value || '—' }))} /> : null}
              <p className="fw-fs-quiet">{t('unit.ownFactsNote')}</p>
            </>
          )}
        </section>
      </div>
    </WindowShell>
  )
}

// ── Move ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MoveWindowModel {
  readonly open: boolean
  readonly drag: Drag | null
  /** The unit's or the person's name. */
  readonly name: string
  /** The confirm step (a pick or a drop asks first); null: the pick list. */
  readonly ask: MoveAsk | null
  /** A drop the rules refuse (a unit under a team, under itself…): said, nothing moves. */
  readonly refusal: Words | null
  readonly targets: { readonly top: boolean; readonly units: readonly UnitNode[] }
  readonly query: string
  readonly busy: boolean
  readonly problem: string | null
}

export interface MoveWindowActions {
  readonly onClose: () => void
  readonly onQuery: (text: string) => void
  readonly onPick: (targetId: string | null) => void
  readonly onBack: () => void
  readonly onMove: () => void
}

export function MoveWindow({ model, actions }: { model: MoveWindowModel; actions: MoveWindowActions }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  if (!model.drag) return null
  const ask = model.ask
  const shown = filterUnits(model.targets.units, model.query)
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={t(ask ? 'move.askTitle' : 'move.title', { name: model.name })}
      subtitle={ask ? undefined : t(model.drag.kind === 'unit' ? 'move.pickUnit' : 'move.pickPerson')}
      act={ask ? { words: t('move.act'), onAct: actions.onMove, busy: model.busy } : null}
      more={ask ? <Button size="sm" variant="quiet" onClick={actions.onBack}>{t('move.otherPlace')}</Button> : undefined}
    >
      <Problem problem={model.problem} />
      {model.refusal ? <Banner tone="warning" title={said(t, model.refusal)} /> : null}
      {ask ? (
        <p className="fw-fs-ask">
          {ask.kind === 'unit'
            ? t('move.askUnit', { name: model.name, to: ask.to ?? t('glance.top'), count: ask.people })
            : [t(ask.from ? 'move.askPersonFrom' : 'move.askPerson', { name: model.name, from: ask.from ?? '', to: ask.to }), ask.leaves && ask.from ? t('move.leavesLeader', { unit: ask.from }) : null].filter(Boolean).join(' ')}
        </p>
      ) : (
        <>
          <Input size="sm" leadingIcon={<Search size={14} aria-hidden />} value={model.query} onChange={(event) => actions.onQuery(event.target.value)} placeholder={t('move.find')} aria-label={t('move.find')} />
          <ul className="fw-fs-picks">
            {model.targets.top && !model.query.trim() ? (
              <li>
                <button type="button" className="fw-fs-pick" onClick={() => actions.onPick(null)}>
                  <ArrowRightLeft size={16} aria-hidden />
                  <span className="fw-fs-card-name">{t('move.top')}</span>
                </button>
              </li>
            ) : null}
            {shown.map((node) => (
              <li key={node.unit.id}>
                <button type="button" className="fw-fs-pick" style={{ paddingInlineStart: `calc(var(--nds-space-10) + ${node.depth} * var(--nds-space-16))` }} onClick={() => actions.onPick(node.unit.id)}>
                  <PeoplePicture source={sourceOfPicture(node.unit.name, node.unit.picture, 'team')} size="sm" nameBeside />
                  <span className="fw-fs-card-t">
                    <span className="fw-fs-card-name">{node.unit.name}</span>
                    <span className="fw-fs-card-sub">{[node.unit.takesOrders ? t('unit.team') : node.unit.kindWord, node.unit.leader?.name ?? t('unit.noLeader')].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? <p className="fw-fs-quiet">{t('move.none')}</p> : null}
        </>
      )}
    </WindowShell>
  )
}

// ── Merge ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MergeWindowModel {
  readonly open: boolean
  readonly draft: MergeDraft | null
  readonly tree: Tree | null
  readonly candidates: readonly UnitNode[]
  readonly leaders: readonly { readonly employeeId: string; readonly name: string }[]
  readonly moves: { readonly people: number; readonly units: number }
  readonly query: string
  readonly busy: boolean
  readonly problem: string | null
}

export interface MergeWindowActions {
  readonly onClose: () => void
  readonly onQuery: (text: string) => void
  readonly onTick: (unitId: string) => void
  readonly onNext: () => void
  readonly onBack: () => void
  readonly onKeep: (unitId: string) => void
  readonly onName: (text: string) => void
  readonly onLeader: (employeeId: string | null) => void
  readonly onMerge: () => void
}

export function MergeWindow({ model, actions }: { model: MergeWindowModel; actions: MergeWindowActions }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  const draft = model.draft
  const base = draft ? model.tree?.byId.get(draft.baseId) : null
  if (!draft || !base) return null
  const team = base.unit.takesOrders
  const held = mergeHeldOf(draft)
  const ids = mergeIdsOf(draft)
  if (draft.step === 'pick') {
    const shown = filterUnits(model.candidates, model.query)
    return (
      <WindowShell
        open={model.open}
        onClose={actions.onClose}
        title={t('merge.title', { name: base.unit.name })}
        subtitle={t(team ? 'merge.pickTeams' : 'merge.pickUnits')}
        act={{ words: t('merge.next'), onAct: actions.onNext, held: said(t, held) }}
        more={<span className="fw-fs-card-sub">{draft.picked.length ? t('merge.ticked', { count: draft.picked.length }) : t('merge.nothingTicked')}</span>}
      >
        <Input size="sm" leadingIcon={<Search size={14} aria-hidden />} value={model.query} onChange={(event) => actions.onQuery(event.target.value)} placeholder={t('move.find')} aria-label={t('move.find')} />
        <ul className="fw-fs-picks">
          {shown.map((node) => (
            <li key={node.unit.id}>
              <label className="fw-fs-pick">
                <Checkbox checked={draft.picked.includes(node.unit.id)} onChange={() => actions.onTick(node.unit.id)} />
                <PeoplePicture source={sourceOfPicture(node.unit.name, node.unit.picture, 'team')} size="sm" nameBeside />
                <span className="fw-fs-card-t">
                  <span className="fw-fs-card-name">{node.unit.name}</span>
                  <span className="fw-fs-card-sub">{[node.unit.leader?.name ?? t('unit.noLeader'), t('head.people', { count: node.total })].join(' · ')}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {shown.length === 0 ? <p className="fw-fs-quiet">{t('merge.none')}</p> : null}
      </WindowShell>
    )
  }
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={t('merge.confirmTitle', { count: ids.length })}
      subtitle={ids.map((id) => model.tree?.byId.get(id)?.unit.name ?? '').join(' + ')}
      act={{ words: t('merge.act'), onAct: actions.onMerge, held: said(t, held), busy: model.busy }}
      more={<Button size="sm" variant="quiet" onClick={actions.onBack}>{t('merge.back')}</Button>}
    >
      <Problem problem={model.problem} />
      <fieldset className="fw-fs-fieldset">
        <legend className="fw-fs-label">{t('merge.keep')}</legend>
        {ids.map((id) => {
          const node = model.tree?.byId.get(id)
          if (!node) return null
          return (
            <RadioCard
              key={id}
              name="fw-fs-keep"
              value={id}
              checked={draft.keepId === id}
              selected={draft.keepId === id}
              onChange={() => actions.onKeep(id)}
              title={
                <span className="fw-fs-pick-t">
                  <PeoplePicture source={sourceOfPicture(node.unit.name, node.unit.picture, 'team')} size="sm" nameBeside />
                  {node.unit.name}
                </span>
              }
              description={[node.unit.leader ? t('unit.leads', { name: node.unit.leader.name }) : t('unit.noLeader'), t('head.people', { count: node.total })].join(' · ')}
            />
          )
        })}
      </fieldset>
      <Field label={t(team ? 'merge.nameTeam' : 'merge.nameUnit')}>
        <Input size="sm" value={draft.name} maxLength={NAME_MAX} onChange={(event) => actions.onName(event.target.value)} />
      </Field>
      <span className="fw-fs-label">{t('merge.leader')}</span>
      <div className="fw-fs-pills" role="group" aria-label={t('merge.leader')}>
        {model.leaders.map((leader) => (
          <Button key={leader.employeeId} size="sm" active={draft.leaderId === leader.employeeId} aria-pressed={draft.leaderId === leader.employeeId} onClick={() => actions.onLeader(leader.employeeId)}>
            {leader.name}
          </Button>
        ))}
        <Button size="sm" active={draft.leaderId === null} aria-pressed={draft.leaderId === null} onClick={() => actions.onLeader(null)}>
          {t('unit.nobody')}
        </Button>
      </div>
      <Banner tone="info" title={t(team ? 'merge.movesTeam' : 'merge.movesUnit', { count: model.moves.people })}>
        {t('merge.closedNote', { count: model.moves.units })}
      </Banner>
    </WindowShell>
  )
}

// ── Close ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CloseWindowModel {
  readonly open: boolean
  readonly node: UnitNode | null
  readonly reading: boolean
  readonly blockers: readonly Words[]
  readonly busy: boolean
  readonly problem: string | null
}

export function CloseWindow({ model, onClose, onMerge, onConfirm }: { model: CloseWindowModel; onClose: () => void; onMerge: () => void; onConfirm: () => void }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  const node = model.node
  if (!node) return null
  const blocked = model.blockers.length > 0
  return (
    <WindowShell
      open={model.open}
      onClose={onClose}
      title={t(blocked ? 'close.blockedTitle' : 'close.title', { name: node.unit.name })}
      act={blocked || model.reading ? null : { words: t('close.act'), onAct: onConfirm, danger: true, busy: model.busy }}
      more={blocked && node.unit.parentId !== null ? <Button size="sm" onClick={onMerge}>{t('profile.merge')}</Button> : undefined}
    >
      <Problem problem={model.problem} />
      {model.reading ? (
        <Skeleton height={48} />
      ) : blocked ? (
        <>
          <p className="fw-fs-ask">{t('close.first')}</p>
          <ul className="fw-fs-blockers">
            {model.blockers.map((blocker) => (
              <li key={blocker.key}>{t(blocker.key, blocker.params)}</li>
            ))}
          </ul>
          <p className="fw-fs-quiet">{t('close.orMerge')}</p>
        </>
      ) : (
        <p className="fw-fs-ask">{t('close.kept')}</p>
      )}
    </WindowShell>
  )
}

// ── Ready-made ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadyMadeWindowModel {
  readonly open: boolean
  readonly pick: ReadyMade | null
  readonly preview: ReadyMadePreview | null
  readonly reading: boolean
  readonly busy: boolean
  readonly problem: string | null
}

export function ReadyMadeWindow({ model, onClose, onPick, onApply }: { model: ReadyMadeWindowModel; onClose: () => void; onPick: (kind: ReadyMade) => void; onApply: () => void }): ReactElement {
  const t = useT(STRUCTURE_NS)
  const changes = model.preview?.rows ?? []
  const ready = model.pick !== null && model.preview !== null && !model.reading
  return (
    <WindowShell
      open={model.open}
      onClose={onClose}
      title={t('ready.title')}
      subtitle={t('ready.subtitle')}
      act={ready && changes.length > 0 ? { words: t('ready.act'), onAct: onApply, busy: model.busy } : null}
    >
      <Problem problem={model.problem} />
      <fieldset className="fw-fs-fieldset">
        <legend className="fw-fs-label">{t('ready.choose')}</legend>
        {READY_MADE.map((kind) => (
          <RadioCard key={kind} name="fw-fs-ready" value={kind} checked={model.pick === kind} selected={model.pick === kind} onChange={() => onPick(kind)} title={t(`ready.${kind}.name`)} description={t(`ready.${kind}.does`)} />
        ))}
      </fieldset>
      {model.pick === null ? null : model.reading ? (
        <Skeleton height={48} />
      ) : changes.length === 0 ? (
        <Banner tone="success" icon={<Check size={16} aria-hidden />} title={t('ready.nothing')} />
      ) : (
        <Banner tone="warning" title={t('ready.changes', { count: changes.length })}>
          <ul className="fw-fs-blockers">
            {changes.map((row, index) => (
              <li key={`${row.name}-${index}`}>
                <b>{row.name}</b>: {row.words}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      <p className="fw-fs-quiet">{t('ready.note')}</p>
    </WindowShell>
  )
}

// ── Edit the person · Add a person ───────────────────────────────────────────────────────────────────────────────────────────

export interface PersonWindowModel {
  readonly open: boolean
  readonly name: string
  readonly draft: PersonDraft | null
  /** The phone field (the personal right). */
  readonly phone: boolean
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface PersonWindowActions {
  readonly onClose: () => void
  readonly onRole: (text: string) => void
  readonly onPhone: (text: string) => void
  readonly onSpeaks: (locale: string) => void
  readonly onSince: (day: string) => void
  readonly onSave: () => void
}

export function PersonWindow({ model, actions }: { model: PersonWindowModel; actions: PersonWindowActions }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  const draft = model.draft
  if (!draft) return null
  const speaks: readonly string[] = (SPEAKS as readonly string[]).includes(draft.locale) ? SPEAKS : [...SPEAKS, draft.locale]
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('person.editTitle')} subtitle={model.name} size="lg" act={{ words: t('unit.save'), onAct: actions.onSave, held: said(t, model.held), busy: model.busy }}>
      <Problem problem={model.problem} />
      <div className="fw-fs-cols">
        <section className="fw-fs-col" aria-label={t('unit.whoItIs')}>
          <h3 className="fw-fs-h3">{t('unit.whoItIs')}</h3>
          <Field label={t('person.role')} hint={t('person.roleHint')}>
            <Input size="sm" value={draft.role} maxLength={ROLE_MAX} onChange={(event) => actions.onRole(event.target.value)} />
          </Field>
          {model.phone ? (
            <Field label={t('facts.phone')} hint={t('person.phoneHint')}>
              <Input size="sm" type="tel" inputMode="tel" value={draft.phone} maxLength={PHONE_MAX} onChange={(event) => actions.onPhone(event.target.value)} />
            </Field>
          ) : null}
        </section>
        <section className="fw-fs-col" aria-label={t('person.howWorks')}>
          <h3 className="fw-fs-h3">{t('person.howWorks')}</h3>
          <span className="fw-fs-label">{t('facts.speaks')}</span>
          <SegmentedControl size="sm" wrap ariaLabel={t('facts.speaks')} value={draft.locale} onChange={actions.onSpeaks} options={speaks.map((code) => ({ value: code, label: t(`speaks.${code}`) === `speaks.${code}` ? code.toUpperCase() : t(`speaks.${code}`) }))} />
          <p className="fw-fs-quiet">{t('person.speaksHint')}</p>
          <div className="fw-fs-field">
            <span className="fw-fs-label" aria-hidden>
              {t('facts.since')}
            </span>
            <DateField value={draft.since} onChange={actions.onSince} ariaLabel={t('facts.since')} />
          </div>
        </section>
      </div>
      <p className="fw-fs-quiet">{t('person.privacy')}</p>
    </WindowShell>
  )
}

export interface AddPersonWindowModel {
  readonly open: boolean
  readonly draft: AddDraft | null
  readonly units: readonly { readonly id: string; readonly name: string; readonly depth: number }[]
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface AddPersonWindowActions {
  readonly onClose: () => void
  readonly onFirst: (text: string) => void
  readonly onLast: (text: string) => void
  readonly onRole: (text: string) => void
  readonly onUnit: (unitId: string) => void
  readonly onStart: (day: string) => void
  readonly onAdd: () => void
}

export function AddPersonWindow({ model, actions }: { model: AddPersonWindowModel; actions: AddPersonWindowActions }): ReactElement | null {
  const t = useT(STRUCTURE_NS)
  const draft = model.draft
  if (!draft) return null
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('add.title')} subtitle={t('add.subtitle')} act={{ words: t('add.act'), onAct: actions.onAdd, held: said(t, model.held), busy: model.busy }}>
      <Problem problem={model.problem} />
      <div className="fw-fs-two">
        <Field label={t('add.first')}>
          <Input size="sm" value={draft.firstName} maxLength={NAME_MAX} onChange={(event) => actions.onFirst(event.target.value)} />
        </Field>
        <Field label={t('add.last')}>
          <Input size="sm" value={draft.lastName} maxLength={NAME_MAX} onChange={(event) => actions.onLast(event.target.value)} />
        </Field>
      </div>
      <Field label={t('person.role')} hint={t('person.roleHint')}>
        <Input size="sm" value={draft.role} maxLength={ROLE_MAX} onChange={(event) => actions.onRole(event.target.value)} />
      </Field>
      <label className="fw-fs-field">
        <span className="fw-fs-label">{t('add.unit')}</span>
        <Select size="sm" value={draft.unitId ?? ''} onChange={(event) => actions.onUnit(event.target.value)}>
          <option value="">{t('add.pickUnit')}</option>
          {model.units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {`${'– '.repeat(unit.depth)}${unit.name}`}
            </option>
          ))}
        </Select>
      </label>
      <div className="fw-fs-field">
        <span className="fw-fs-label" aria-hidden>
          {t('facts.since')}
        </span>
        <DateField value={draft.startDate} onChange={actions.onStart} ariaLabel={t('facts.since')} />
      </div>
    </WindowShell>
  )
}

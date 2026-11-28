'use client'

import type { ReactElement } from 'react'
import { Plus, Search, Split, Users, X } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Input, NumberStepper, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import { GIVE_WHY_MAX, giveHeldOf, modeNoteOf, ORDER_TEAMS_NS, splitHeldOf, startedEmpty, sumLineOf, type Candidate, type GiveDraft, type RowFacts } from '../model'
import { TeamFactsLine } from './TeamFactsLine'
import '../teams.css'

/**
 * owb-ss7 (7.2; design § 5zd "The teams of an order": one ROW a team, as many as you want; Add a team · take a team off · Put in charge
 * (ONE) · They work together / They split the baskets; a split: a number per team with − and +, Share them evenly, the line "9 of 12
 * baskets are given"; § 5zd "every window has the same build": the window shell) — "Give to a team…". Draws one model; fetches nothing.
 * Save waits with words while the baskets do not add up, a share is 0, or nothing changed. After the first print the shares are read
 * only ("The baskets were shared at print"); teams that work together can still be added or taken off.
 */

export interface GiveWindowModel {
  readonly open: boolean
  readonly phase: 'reading' | 'ready' | 'failed'
  /** The read's failure (a key of `order-teams`). */
  readonly problem: string | null
  /** The order's number when the page knows it (the board's card); the part has only its id. */
  readonly orderNumber: string | null
  readonly draft: GiveDraft | null
  readonly facts: ReadonlyMap<string, RowFacts>
  readonly candidates: readonly Candidate[]
  /** The teams of the board could not be read: "Add a team" says so. */
  readonly boardFailed: boolean
  readonly query: string
  readonly busy: boolean
  /** The save's failure (a key of `order-teams`). */
  readonly saveProblem: string | null
}

export interface GiveWindowActions {
  readonly onClose: () => void
  readonly onRetry: () => void
  readonly onAdd: (teamId: string) => void
  readonly onRemove: (teamId: string) => void
  readonly onInCharge: (teamId: string) => void
  readonly onMode: (mode: 'TOGETHER' | 'SPLIT') => void
  readonly onShare: (teamId: string, value: number) => void
  readonly onEven: () => void
  readonly onWhy: (text: string) => void
  readonly onQuery: (text: string) => void
  readonly onSave: () => void
}

export function GiveTeamsWindow({ model, actions }: { model: GiveWindowModel; actions: GiveWindowActions }): ReactElement {
  const t = useT(ORDER_TEAMS_NS)
  const draft = model.draft
  const held = draft ? giveHeldOf(draft) : null
  const subtitle = draft ? [model.orderNumber, t('give.planned', { count: draft.planned })].filter(Boolean).join(' · ') : (model.orderNumber ?? undefined)
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={t('give.title')}
      subtitle={subtitle}
      size="lg"
      act={draft && model.phase === 'ready' ? { words: t('give.act'), onAct: actions.onSave, held: held ? t(held.key, held.params) : null, busy: model.busy } : null}
    >
      {model.phase === 'reading' ? (
        <div className="fw-tm-skel" aria-busy="true">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : model.phase === 'failed' || !draft ? (
        <Banner
          tone="danger"
          title={t(model.problem ?? 'error.read')}
          action={
            <Button size="sm" onClick={actions.onRetry}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <GiveBody model={model} draft={draft} actions={actions} />
      )}
    </WindowShell>
  )
}

function GiveBody({ model, draft, actions }: { model: GiveWindowModel; draft: GiveDraft; actions: GiveWindowActions }): ReactElement {
  const t = useT(ORDER_TEAMS_NS)
  const many = draft.rows.length > 1
  const split = draft.mode === 'SPLIT' && many
  const splitHeld = splitHeldOf(draft)
  const sum = sumLineOf(draft)
  const note = modeNoteOf(draft)
  return (
    <div className="fw-tm-give">
      {model.saveProblem ? <Banner tone="danger" title={t(model.saveProblem)} /> : null}
      <div className="fw-tm-give-head">
        <span className="fw-tm-give-count">{draft.rows.length > 0 ? t('give.count', { count: draft.rows.length }) : t('give.countNone')}</span>
        {many ? (
          <span className="fw-tm-modes" role="group" aria-label={t('give.mode.label')}>
            <Button size="sm" active={!split} aria-pressed={!split} onClick={() => actions.onMode('TOGETHER')} heldReason={draft.printed && split ? t('give.held.sharedAtPrint') : null}>
              <Users size={14} aria-hidden />
              {t('give.mode.TOGETHER')}
            </Button>
            <Button size="sm" active={split} aria-pressed={split} onClick={() => actions.onMode('SPLIT')} heldReason={split ? null : splitHeld ? t(splitHeld.key, splitHeld.params) : null}>
              <Split size={14} aria-hidden />
              {t('give.mode.SPLIT')}
            </Button>
          </span>
        ) : null}
      </div>

      {draft.rows.length > 0 ? (
        <ul className="fw-tm-rows">
          {draft.rows.map((row) => {
            const facts = model.facts.get(row.teamId)
            const name = facts?.face.name ?? row.teamId
            const boss = draft.inCharge === row.teamId
            return (
              <li key={row.teamId} className={`fw-tm-row${boss && many ? ' is-boss' : ''}`}>
                <PeoplePicture source={sourceOfPicture(name, facts?.face.picture, 'team')} nameBeside />
                <span className="fw-tm-row-t">
                  <span className="fw-tm-row-name">{name}</span>
                  {facts ? <TeamFactsLine facts={facts} /> : null}
                </span>
                <span className="fw-tm-row-acts">
                  {row.locked ? (
                    <span className="fw-tm-locked">
                      <Tag tone="neutral">{t('give.locked')}</Tag>
                      <span className="fw-tm-share-n">{t('part.share', { count: row.share ?? 0 })}</span>
                    </span>
                  ) : split && !draft.printed ? (
                    <NumberStepper
                      size="sm"
                      value={row.share ?? 0}
                      min={0}
                      max={draft.planned}
                      onChange={(next) => actions.onShare(row.teamId, next)}
                      decrementLabel={t('give.less', { team: name })}
                      incrementLabel={t('give.more', { team: name })}
                      aria-label={t('give.shareLabel', { team: name })}
                    />
                  ) : draft.printed && draft.mode === 'SPLIT' ? (
                    <Tag tone="info">{t('give.together')}</Tag>
                  ) : null}
                  {many ? (
                    <Button size="sm" active={boss} aria-pressed={boss} title={t('give.inChargeHint')} onClick={() => actions.onInCharge(row.teamId)}>
                      {boss ? t('give.inCharge') : t('give.putInCharge')}
                    </Button>
                  ) : null}
                  {row.locked ? null : (
                    <Button size="sm" variant="quiet" className="icon" aria-label={t('give.remove', { team: name })} title={t('give.remove', { team: name })} onClick={() => actions.onRemove(row.teamId)}>
                      <X size={16} aria-hidden />
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="fw-tm-quiet">{startedEmpty(draft) ? t('give.empty') : t('give.note.noTeam')}</p>
      )}

      {sum ? (
        <div className={`fw-tm-sum is-${sum.state}`} role="status">
          <span className="fw-tm-grow">{t(sum.words.key, sum.words.params)}</span>
          <Button size="sm" onClick={actions.onEven}>
            {t('give.even')}
          </Button>
        </div>
      ) : null}
      {note && draft.rows.length > 0 ? <p className="fw-tm-note">{t(note.key, note.params)}</p> : null}

      <section className="fw-tm-add" aria-label={t('give.add')}>
        <h3 className="fw-tm-h3">{t('give.add')}</h3>
        <Input size="sm" leadingIcon={<Search size={14} aria-hidden />} value={model.query} onChange={(event) => actions.onQuery(event.target.value)} placeholder={t('give.search')} aria-label={t('give.search')} />
        {model.boardFailed ? (
          <p className="fw-tm-quiet">{t('give.noBoard')}</p>
        ) : model.candidates.length === 0 ? (
          <p className="fw-tm-quiet">{model.query.trim() ? t('give.noMatch', { query: model.query.trim() }) : t('give.noMore')}</p>
        ) : (
          <ul className="fw-tm-cands">
            {model.candidates.map((candidate) => (
              <li key={candidate.facts.face.id}>
                <button type="button" className="fw-tm-cand" aria-label={t('give.addOne', { team: candidate.facts.face.name })} onClick={() => actions.onAdd(candidate.facts.face.id)}>
                  <PeoplePicture source={sourceOfPicture(candidate.facts.face.name, candidate.facts.face.picture, 'team')} nameBeside />
                  <span className="fw-tm-row-t">
                    <span className="fw-tm-row-name">
                      {candidate.facts.face.name}
                      {candidate.suggested ? <Tag tone="info">{t('give.suggested')}</Tag> : null}
                    </span>
                    <TeamFactsLine facts={candidate.facts} />
                  </span>
                  <Plus size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <label className="fw-tm-field">
        <span>{t('give.why')}</span>
        <Input size="sm" value={draft.why} maxLength={GIVE_WHY_MAX} placeholder={t('give.whyHint')} onChange={(event) => actions.onWhy(event.target.value)} />
      </label>
    </div>
  )
}

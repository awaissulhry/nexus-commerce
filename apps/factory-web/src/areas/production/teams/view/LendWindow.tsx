'use client'

import type { ReactElement } from 'react'
import { Banner } from '@nexus/ui/components'
import { RadioCard, SegmentedControl } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import type { BoardTeam } from '../api'
import { BOARD_NS, LEND_REASON_MAX, LEND_UNTIL, type LendDraft, type LendUntil, type Words } from '../model'
import '../teams.css'

/**
 * owb-ss7 (7.2; design § 5za "a person helps another team: a loan with an end", § 5zd "Lend a person: until ANY day you choose, at most
 * 31 days, with a reason; Today · 3 days · a week stay one-press choices") — "Lend {name}" on the window shell. To which team, until when,
 * why, and ONE act "Lend" at the bottom. The home team stays. A team with no line says "This team has no line: a loan needs a line for
 * now" (L9) and Lend waits. Draws one model; fetches nothing.
 */

export interface LendWindowModel {
  readonly open: boolean
  readonly draft: LendDraft | null
  /** The home team's name; null for a shared worker (no home team). */
  readonly homeName: string | null
  readonly teams: readonly BoardTeam[]
  /** Today and the last day a loan may reach (YYYY-MM-DD, the site's zone). */
  readonly today: string
  readonly maxDay: string
  readonly held: Words | null
  readonly busy: boolean
  /** The loan's refusal or failure (a key of `teams-board`). */
  readonly problem: string | null
}

export interface LendWindowActions {
  readonly onClose: () => void
  readonly onTeam: (teamId: string) => void
  readonly onUntil: (until: LendUntil) => void
  readonly onPick: (day: string) => void
  readonly onReason: (text: string) => void
  readonly onLend: () => void
}

export function LendWindow({ model, actions }: { model: LendWindowModel; actions: LendWindowActions }): ReactElement | null {
  const t = useT(BOARD_NS)
  const draft = model.draft
  if (!draft) return null
  return (
    <WindowShell
      open={model.open}
      onClose={actions.onClose}
      title={t('lend.title', { name: draft.name })}
      subtitle={model.homeName ? t('lend.home', { team: model.homeName }) : t('lend.homeNone')}
      act={{ words: t('lend.act'), onAct: actions.onLend, held: model.held ? t(model.held.key, model.held.params) : null, busy: model.busy }}
    >
      <div className="fw-tm-lend">
        {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
        <div className="fw-tm-lend-who">
          <PeoplePicture source={{ name: draft.name, who: 'person' }} size="lg" nameBeside />
          <p className="fw-tm-note">{t('lend.body')}</p>
        </div>
        <fieldset className="fw-tm-fieldset">
          <legend className="fw-tm-h3">{t('lend.to')}</legend>
          {model.teams.length === 0 ? (
            <p className="fw-tm-quiet">{t('lend.noOther')}</p>
          ) : (
            <div className="fw-tm-lend-teams">
              {model.teams.map((team) => (
                <RadioCard
                  key={team.id}
                  variant="row"
                  name="fw-tm-lend-team"
                  value={team.id}
                  checked={draft.toTeamId === team.id}
                  selected={draft.toTeamId === team.id}
                  onChange={() => actions.onTeam(team.id)}
                  title={
                    <span className="fw-tm-lend-team">
                      <PeoplePicture source={sourceOfPicture(team.name, team.picture, 'team')} size="sm" nameBeside />
                      <span>{team.name}</span>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </fieldset>
        <div className="fw-tm-fieldset">
          <span className="fw-tm-h3">{t('lend.until')}</span>
          <SegmentedControl
            size="sm"
            wrap
            ariaLabel={t('lend.until')}
            value={draft.until}
            onChange={(value) => actions.onUntil(value as LendUntil)}
            options={LEND_UNTIL.map((until) => ({ value: until, label: t(`lend.untilChoice.${until}`) }))}
          />
          {draft.until === 'DAY' ? (
            <div className="fw-tm-field">
              <span aria-hidden>{t('lend.pick')}</span>
              <DateField value={draft.picked} min={model.today} max={model.maxDay} onChange={actions.onPick} ariaLabel={t('lend.pick')} />
            </div>
          ) : null}
        </div>
        <label className="fw-tm-field">
          <span>{t('lend.reason')}</span>
          <Textarea rows={2} honourRows value={draft.reason} limit={LEND_REASON_MAX} placeholder={t('lend.reasonHint')} onChange={(event) => actions.onReason(event.target.value)} />
        </label>
      </div>
    </WindowShell>
  )
}

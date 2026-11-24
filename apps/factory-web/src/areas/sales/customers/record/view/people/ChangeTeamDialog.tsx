'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { said } from '../../people/model'
import { teamProblem, type PeopleTabActions, type TeamDialog } from '../../people/tab'
import { usePeopleSay } from './say'

/**
 * F-CA-213 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.3; 10-design §6 window 5) — NEW window "Change the team of
 * {rider}" (560): keep it under its team, move it to another team (a team customer found by name or code), or take it off any team (it
 * stays a customer of its own). Orders already made keep their customer and their measurements. Cancel · Save — PUT /parties/:rider/team
 * with the rider's version (parties.manage on the rider). `ChangeTeamBody` is its inside (a design case draws it on a plain card).
 */

export interface ChangeTeamProps {
  readonly dialog: TeamDialog
  readonly actions?: PeopleTabActions | undefined
}

export function ChangeTeamDialog(props: ChangeTeamProps) {
  const say = usePeopleSay()
  const { dialog, actions } = props
  const problem = teamProblem(dialog)
  return (
    <Modal
      open
      size="md"
      busy={dialog.busy}
      onClose={() => actions?.onTeamClose?.()}
      title={say(said('team.title', { params: { name: dialog.riderName } }))}
      subtitle={dialog.current ? say(said('team.sub', { params: { team: dialog.current.name } })) : say(said('team.subNone'))}
      footer={
        <>
          <Button onClick={() => actions?.onTeamClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={dialog.busy ? say(said('parties:common.saving')) : dialog.tried && problem ? say(said(problem)) : null} onClick={() => actions?.onTeamConfirm?.()}>
            {say(said('parties:common.save'))}
          </Button>
        </>
      }
    >
      <ChangeTeamBody {...props} />
    </Modal>
  )
}

export function ChangeTeamBody({ dialog, actions }: ChangeTeamProps) {
  const say = usePeopleSay()
  const draft = (patch: Parameters<NonNullable<PeopleTabActions['onTeamDraft']>>[0]) => actions?.onTeamDraft?.(patch)
  const found = dialog.found
  return (
    <div className="fw-ca-win">
      <fieldset className="fw-ca-fs" disabled={dialog.busy}>
        <legend className="fw-ca-legend">{say(said('team.label'))}</legend>
        <RadioCard name="team-choice" value="keep" checked={dialog.choice === 'keep'} selected={dialog.choice === 'keep'} onChange={() => draft({ choice: 'keep' })} title={dialog.current ? say(said('team.keep', { params: { team: dialog.current.name } })) : say(said('team.keepNone'))} />
        <RadioCard name="team-choice" value="move" checked={dialog.choice === 'move'} selected={dialog.choice === 'move'} onChange={() => draft({ choice: 'move' })} title={say(said('team.move'))} description={dialog.picked ? say(said('team.movePicked', { params: { team: dialog.picked.name } })) : undefined} />
        {dialog.current ? <RadioCard name="team-choice" value="off" checked={dialog.choice === 'off'} selected={dialog.choice === 'off'} onChange={() => draft({ choice: 'off' })} title={say(said('team.off'))} description={say(said('team.offLine', { params: { name: dialog.riderName } }))} /> : null}
      </fieldset>
      {dialog.choice === 'move' && !dialog.busy ? (
        <div className="fw-ca-search">
          <Field label={say(said('team.find'))} error={dialog.tried && teamProblem(dialog) ? say(said('team.problem.pick')) : undefined}>
            <Input type="search" value={dialog.search} onChange={(event) => draft({ search: event.target.value })} autoComplete="off" />
          </Field>
          {found?.status === 'loading' ? <p className="fw-ca-sub">{say(said('rider.searching'))}</p> : null}
          {found?.status === 'error' ? <p className="fw-ca-sub is-warning">{say(said(`parties:${found.problem}`))}</p> : null}
          {found?.status === 'ready' ? (
            found.value.length === 0 ? (
              <p className="fw-ca-sub">{say(said('team.noneFound'))}</p>
            ) : (
              <ul className="fw-ca-found">
                {found.value.map((party) => (
                  <li key={party.id}>
                    <button type="button" className="fw-ca-lk fw-ca-plain" aria-pressed={dialog.picked?.id === party.id} onClick={() => draft({ picked: party })}>
                      {party.name}
                    </button>
                    <span className="fw-ca-sub">{[party.code, party.city].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
      <p className="fw-ca-sub">{say(said('team.kept'))}</p>
      {dialog.problem ? <Banner tone="danger" title={say(said(`parties:${dialog.problem}`))} /> : null}
    </div>
  )
}

'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { LanguageSelect } from '../../../../../parties/_shared/view/dialogs'
import { said, type Say } from '../../people/model'
import { addRiderProblem, type AddRiderDialog as Dialog, type PeopleTabActions } from '../../people/tab'
import { usePeopleSay } from './say'

/**
 * F-CA-212 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.3; 10-design §6 window 4; Z10) — NEW window "Add a rider to
 * {team}" (560): what kind of rider — with their own page (a person customer made, then put under the team: the two existing commands,
 * said in one line; when the second fails, "{rider} was made, not yet under {team}: Try again" sends only that one) or kept on the team
 * (the record's own Add contact window opens with Rider ticked); or an existing person customer put under the team. Cancel · Add rider.
 * `AddRiderBody` is its inside (a design case draws it on a plain card).
 */

export interface AddRiderProps {
  readonly dialog: Dialog
  readonly team: string
  readonly actions?: PeopleTabActions | undefined
}

export function AddRiderDialog(props: AddRiderProps) {
  const say = usePeopleSay()
  const { dialog, team, actions } = props
  const problem = addRiderProblem(dialog)
  const confirm = dialog.kind === 'kept' ? say(said('rider.next')) : dialog.made ? say(said('rider.retry')) : say(said('rider.confirm'))
  return (
    <Modal
      open
      size="md"
      busy={dialog.busy}
      onClose={() => actions?.onAddRiderClose?.()}
      title={say(said('rider.title', { params: { team } }))}
      subtitle={say(said('rider.sub'))}
      footer={
        <>
          <Button onClick={() => actions?.onAddRiderClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={dialog.busy ? say(said('parties:common.saving')) : dialog.tried && problem ? say(said(problem)) : null} onClick={() => actions?.onAddRiderConfirm?.()}>
            {confirm}
          </Button>
        </>
      }
    >
      <AddRiderBody {...props} />
    </Modal>
  )
}

export function AddRiderBody({ dialog, team, actions }: AddRiderProps) {
  const say = usePeopleSay()
  const problem = dialog.tried ? addRiderProblem(dialog) : null
  const draft = (patch: Parameters<NonNullable<PeopleTabActions['onAddRiderDraft']>>[0]) => actions?.onAddRiderDraft?.(patch)
  const locked = dialog.made !== null || dialog.busy
  return (
    <div className="fw-ca-win">
      <fieldset className="fw-ca-fs" disabled={locked}>
        <legend className="fw-ca-legend">{say(said('rider.kind'))}</legend>
        <RadioCard name="rider-kind" value="own" checked={dialog.kind === 'own'} selected={dialog.kind === 'own'} onChange={() => draft({ kind: 'own' })} title={say(said('rider.own'))} description={say(said('rider.ownLine', { params: { team } }))} />
        <RadioCard name="rider-kind" value="kept" checked={dialog.kind === 'kept'} selected={dialog.kind === 'kept'} onChange={() => draft({ kind: 'kept' })} title={say(said('rider.kept', { params: { team } }))} description={say(said('rider.keptLine', { params: { team } }))} />
      </fieldset>
      {dialog.kind === 'own' ? (
        <>
          {dialog.picked ? (
            <p className="fw-ca-win-addr">
              <b>{dialog.picked.name}</b>
              <span>{say(said('rider.pickedLine', { params: { name: dialog.picked.name, team } }))}</span>
              {!locked ? (
                <button type="button" className="fw-ca-lk fw-ca-plain" onClick={() => draft({ picked: null })}>
                  {say(said('rider.clearPick'))}
                </button>
              ) : null}
            </p>
          ) : (
            <div className="fw-ca-grid2">
              <Field label={say(said('rider.name'))} required error={problem === 'rider.problem.name' || problem === 'rider.problem.nameLong' ? say(said(problem)) : undefined}>
                <Input value={dialog.name} disabled={locked} maxLength={120} onChange={(event) => draft({ name: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={say(said('rider.email'))} hint={say(said('rider.emailHint'))} error={problem === 'rider.problem.email' ? say(said(problem)) : undefined}>
                <Input type="email" value={dialog.email} disabled={locked} onChange={(event) => draft({ email: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={say(said('rider.phone'))}>
                <Input value={dialog.phone} disabled={locked} onChange={(event) => draft({ phone: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={say(said('rider.language'))}>
                <LanguageSelect value={dialog.language} onChange={(value) => draft({ language: value })} />
              </Field>
            </div>
          )}
          {!dialog.picked && !locked ? <Search dialog={dialog} team={team} say={say} onSearch={(search) => draft({ search })} onPick={(picked) => draft({ picked })} /> : null}
          {!dialog.picked ? <p className="fw-ca-sub">{say(said('rider.twoSteps', { params: { team } }))}</p> : null}
        </>
      ) : null}
      {dialog.made ? <Banner tone="warning" title={say(said('rider.made', { params: { name: dialog.made.name, team } }))} /> : null}
      {dialog.problem ? <Banner tone="danger" title={say(said(`parties:${dialog.problem}`))} /> : null}
    </div>
  )
}

/** "Or put an existing customer under {team}": a person customer found by name or code (the server's search, this reader's customers). */
function Search({ dialog, team, say, onSearch, onPick }: { dialog: Dialog; team: string; say: Say; onSearch: (search: string) => void; onPick: (picked: NonNullable<Dialog['picked']>) => void }) {
  const found = dialog.found
  return (
    <div className="fw-ca-search">
      <Field label={say(said('rider.existing', { params: { team } }))} hint={say(said('rider.existingHint'))}>
        <Input type="search" value={dialog.search} onChange={(event) => onSearch(event.target.value)} autoComplete="off" />
      </Field>
      {found?.status === 'loading' ? <p className="fw-ca-sub">{say(said('rider.searching'))}</p> : null}
      {found?.status === 'error' ? <p className="fw-ca-sub is-warning">{say(said(`parties:${found.problem}`))}</p> : null}
      {found?.status === 'ready' ? (
        found.value.length === 0 ? (
          <p className="fw-ca-sub">{say(said('rider.noneFound'))}</p>
        ) : (
          <ul className="fw-ca-found">
            {found.value.map((party) => (
              <li key={party.id}>
                <button type="button" className="fw-ca-lk fw-ca-plain" onClick={() => onPick(party)}>
                  {party.name}
                </button>
                <span className="fw-ca-sub">{[party.code, party.city].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}

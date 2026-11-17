'use client'

import { Search, UserPlus } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { NO_MANAGE, OFFLINE } from '../../../model'
import { NoticeLine, useWords } from '../../../parts'
import { emptyChoicesKey, PEOPLE_NS, type AddDialogModel, type PeopleBlockActions } from '../model'

/**
 * Add a colleague (PROJ.members-F02: only colleagues who may read the project are offered; they are told) or Add <company> people
 * (F07: only the project's outside company's portal people, exactly as the API offers them — a person of another company can never
 * be picked). A search box over the names (the container reads `GET …/people/choices?q=`), one Add per person, the empty line in
 * words ("Everyone who may see this project is in it already"). Pure: the container reads and writes.
 */
export function AddPersonDialog({ model, project, company, actions }: { model: AddDialogModel; project: string; company: string | null; actions?: NonNullable<PeopleBlockActions['dialog']> }) {
  const { t, say, shared } = useWords(PEOPLE_NS)
  const outside = model.kind === 'outside'
  const name = company ?? ''
  const title = outside ? t('add.outsideTitle', { company: name, project }) : t('add.teamTitle', { project })
  // The outside company's people need projects.manage: the API says so with `mayAddOutside` (an open project shared with one).
  const outsideHeld = outside && model.choices !== null && !model.mayAddOutside ? say(NO_MANAGE) : null
  const pickHeld = model.offline ? say(OFFLINE) : model.busy ? shared('held.busy') : outsideHeld
  return (
    <Modal
      open
      size="md"
      title={title}
      onClose={() => actions?.onClose?.()}
      busy={model.choices === null && model.problem === null}
      footer={
        <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
          {t('add.close')}
        </Button>
      }
    >
      <div className="fw-prjp-dialog">
        <p className="fw-prjp-hint">{outside ? t('add.outsideIntro', { company: name }) : t('add.teamIntro')}</p>
        <NoticeLine notice={model.notice} ns={PEOPLE_NS} />
        <Input
          size="sm"
          type="search"
          leadingIcon={<Search size={14} aria-hidden />}
          aria-label={t('add.search')}
          placeholder={t('add.search')}
          value={model.q}
          onChange={(event) => actions?.onQuery?.(event.target.value)}
        />
        {model.problem ? (
          <Banner
            tone="danger"
            title={shared(model.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {shared('common.retry')}
              </Button>
            }
          />
        ) : model.choices === null ? (
          <p className="fw-prjp-hint" role="status">
            {t('add.reading')}
          </p>
        ) : outsideHeld ? (
          <p className="fw-prjp-hint">{outsideHeld}</p>
        ) : model.choices.length === 0 ? (
          <EmptyState title={t(emptyChoicesKey(model.kind, model.q), { q: model.q.trim(), company: name })} description={outside && model.q.trim() === '' ? t('people.outsideInvite', { company: name }) : undefined} />
        ) : (
          <ul className="fw-prjp-choices" aria-label={title}>
            {model.choices.map((person) => (
              <li key={person.userId} className="fw-prjp-choice">
                <span className="fw-prjp-name">{person.name}</span>
                <Button size="sm" variant="secondary" aria-label={t('add.pickLabel', { name: person.name })} heldReason={pickHeld} onClick={() => actions?.onPick?.(person.userId)}>
                  <UserPlus size={14} aria-hidden /> {model.busy === person.userId ? shared('common.working') : t('add.pick')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

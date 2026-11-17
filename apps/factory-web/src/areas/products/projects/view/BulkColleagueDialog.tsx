'use client'

import { useEffect, useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Button, Input, Radio, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { Notice } from '../model'
import { NoticeLine, useWords } from '../parts'

/**
 * The bulk bar's "Add a colleague…" (PROJ.list-F03): one office colleague added to every selected project (one add per project,
 * each told by the API); a project they may not read is skipped and counted. The colleagues offered are those of the first project
 * picked who may read it and are not in it yet (GET /projects/:id/people/choices) — said in the dialog.
 */
export interface BulkColleagueModel {
  /** The projects selected. */
  count: number
  choices: { items: readonly { userId: string; name: string }[] | null; problem: string | null }
  q: string
  picked: string | null
  busy: boolean
  notice: Notice | null
}

export interface BulkColleagueActions {
  onQuery?: (q: string) => void
  onPick?: (userId: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

export function BulkColleagueDialog({ model, actions }: { model: BulkColleagueModel; actions?: BulkColleagueActions }) {
  const { t, say } = useWords()
  const [q, setQ] = useState(model.q)
  useEffect(() => setQ(model.q), [model.q])
  const items = model.choices.items
  const held = model.busy ? t('common.working') : model.picked ? null : t('bulk.colleague.pickFirst')
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('bulk.colleague.title', { count: model.count })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmit?.()}>
            {t('bulk.colleague.submit', { count: model.count })}
          </Button>
        </>
      }
    >
      <div className="fw-prj-form">
        <p className="fw-prj-hint">{t('bulk.colleague.intro')}</p>
        <Field label={t('bulk.colleague.search')}>
          <Input
            size="sm"
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                actions?.onQuery?.(q)
              }
            }}
            onBlur={() => q !== model.q && actions?.onQuery?.(q)}
          />
        </Field>
        {model.choices.problem ? (
          <p className="fw-prj-hint">{say({ key: model.choices.problem })}</p>
        ) : items === null ? (
          <Skeleton height={96} />
        ) : items.length === 0 ? (
          <p className="fw-prj-hint">{t('bulk.colleague.none')}</p>
        ) : (
          <div className="fw-prj-choices" role="radiogroup" aria-label={t('bulk.colleague.search')}>
            {items.map((person) => (
              <Radio key={person.userId} name="fw-prj-colleague" checked={model.picked === person.userId} onChange={() => actions?.onPick?.(person.userId)} label={person.name} />
            ))}
          </div>
        )}
        <NoticeLine notice={model.notice} />
      </div>
    </Modal>
  )
}

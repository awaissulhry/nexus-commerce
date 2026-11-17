'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FolderPlus, Search } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Input, RadioCard, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ProjectsMessages, StatusPill, useWords } from '../../parts'
import { PROJECT_LIMITS, type Phrase } from '../../model'
import { addToNoteProblem, submitHeld, type AddToProjectActions, type AddToProjectModel } from '../model'
import '../../record/linked/linked.css'

const NS = 'products-projects-linked'

/**
 * B-TH-251 — "Add to project" on the Styles and the Samples & prototypes lists (design X-PRD-STY-LIST.grid, X-PRD-SMP-LIST.grid): the
 * bulk bar's button (held with why without projects.manage, past 200 rows, offline) and the dialog — find an open project by number
 * or name (its outside company, or Office only), an optional note (why, one line), ONE call for every row picked, then the answer in
 * words: "5 linked · 2 skipped" with each skipped row's number and why (another outside company's row: "belongs to another outside
 * company", naming neither company), and Open the project. Each draws one model and fetches nothing.
 */
export function AddToProjectButton({ count, held, onClick }: { count: number; held: Phrase | null; onClick?: () => void }) {
  return (
    <ProjectsMessages also={[NS]}>
      <Trigger count={count} held={held} onClick={onClick} />
    </ProjectsMessages>
  )
}

function Trigger({ count, held, onClick }: { count: number; held: Phrase | null; onClick?: (() => void) | undefined }) {
  const { t, say } = useWords(NS)
  const label = t('addTo.buttonCount', { count })
  return (
    <Button size="sm" aria-label={label} heldReason={say(held)} onClick={() => onClick?.()}>
      <FolderPlus size={13} aria-hidden /> <SelectionLabel>{label}</SelectionLabel>
    </Button>
  )
}

export function AddToProjectDialog({ model, actions }: { model: AddToProjectModel; actions?: AddToProjectActions }) {
  return (
    <ProjectsMessages also={[NS]}>
      <Dialog model={model} actions={actions} />
    </ProjectsMessages>
  )
}

function Dialog({ model, actions }: { model: AddToProjectModel; actions?: AddToProjectActions | undefined }) {
  const { t, say, shared } = useWords(NS)
  const [q, setQ] = useState(model.q)
  useEffect(() => setQ(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onQuery?.(q), 300)
    return () => clearTimeout(timer)
  }, [q])

  const count = model.records.length
  const title = t(model.kind === 'Style' ? 'addTo.titleStyle' : 'addTo.titleSampleRound', { count })

  if (model.result) {
    const result = model.result
    const summary = [t('addTo.result.linked', { count: result.linked }), ...(result.skipped.length > 0 ? [t('addTo.result.skipped', { count: result.skipped.length })] : [])].join(' · ')
    return (
      <Modal
        open
        size="md"
        title={t('addTo.result.title', { project: `${result.project.number} · ${result.project.name}` })}
        onClose={() => actions?.onClose?.()}
        footer={
          <>
            <Button asChild>
              <Link href={result.project.href}>{t('addTo.result.open')}</Link>
            </Button>
            <Button variant="primary" onClick={() => actions?.onClose?.()}>
              {t('addTo.result.done')}
            </Button>
          </>
        }
      >
        <div className="fw-prjl-dialog" role="status">
          <p className="fw-prjl-summary">{summary}</p>
          {result.skipped.length > 0 && (
            <>
              <p className="fw-prjl-text">{t('addTo.result.skippedTitle')}</p>
              <ul className="fw-prjl-skipped">
                {result.skipped.map((entry, index) => (
                  <li key={`${entry.number}-${index}`}>{t('addTo.result.row', { number: entry.number, reason: say(entry.reason) ?? '' })}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    )
  }

  const held = say(submitHeld(model))
  const noteHeld = addToNoteProblem(model.note)
  const projects = model.projects
  return (
    <Modal
      open
      size="md"
      title={title}
      subtitle={t('addTo.intro')}
      onClose={() => actions?.onClose?.()}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('addTo.cancel')}</Button>
          <Button variant="primary" heldReason={held} disabled={model.busy} onClick={() => actions?.onSubmit?.()}>
            {model.busy ? shared('common.working') : t('addTo.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-prjl-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <Input
          type="search"
          size="sm"
          leadingIcon={<Search size={13} aria-hidden />}
          aria-label={t('addTo.search')}
          placeholder={t('addTo.search')}
          value={q}
          autoFocus
          onChange={(event) => {
            typed.current = true
            setQ(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              actions?.onQuery?.(q)
            }
          }}
        />
        <div className="fw-prjl-results" role="group" aria-label={t('addTo.projects')} aria-busy={projects.status === 'loading' || undefined}>
          {projects.status === 'loading' && <p className="fw-prjl-hint" role="status">{t('addTo.loading')}</p>}
          {projects.status === 'error' && (
            <EmptyState
              title={t('addTo.failed')}
              description={shared(projects.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('addTo.retry')}
                </Button>
              }
            />
          )}
          {projects.status === 'ready' && projects.items.length === 0 && <p className="fw-prjl-hint">{t(model.q.trim() ? 'addTo.none' : 'addTo.noneAtAll')}</p>}
          {projects.status === 'ready' &&
            projects.items.map((project) => (
              <RadioCard
                key={project.id}
                variant="row"
                name="fw-prjl-project"
                checked={model.picked === project.id}
                selected={model.picked === project.id}
                onChange={() => actions?.onPick?.(project.id)}
                title={
                  <span className="fw-prjl-candidate">
                    <span className="fw-prjl-num">{project.number}</span>
                    <span>{project.name}</span>
                    {project.status !== 'ACTIVE' && <StatusPill status={project.status} />}
                  </span>
                }
                description={project.party ?? <Tag tone="neutral">{t('addTo.officeOnly')}</Tag>}
              />
            ))}
        </div>
        <Field label={t('addTo.note')} hint={t('addTo.noteHint')} error={noteHeld ? say(noteHeld) : undefined}>
          <Input value={model.note} maxLength={PROJECT_LIMITS.linkNote + 10} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { ProjectsMessages, useWords } from '../../../parts'
import { PROJECT_LIMITS } from '../../../model'
import { LINK_KINDS, LINKED_ALSO, LINKED_NS, noteProblem, typeKey, type LinkDialogActions, type LinkDialogModel } from '../model'
import type { ProjectLinkType } from '@nexus/factory-domain/projects/rules'

/**
 * B-TH-251 — Link a record to the project (design PROJ.linked-F02, F03): a search over number or name (the office search, kept to
 * the kinds a project links and to the project's company; one kind or every kind), the results with their kind and status words,
 * the record picked ("Will link: SO-…"), an optional note (why, one line), Link. A refusal is said in words from its code: a record
 * of another outside company → "<number> belongs to another outside company: it cannot join this project." and the rule — never
 * naming either company. Draws one model, fetches nothing.
 */
export function LinkDialog({ model, actions }: { model: LinkDialogModel; actions?: LinkDialogActions }) {
  return (
    <ProjectsMessages also={LINKED_ALSO}>
      <Dialog model={model} actions={actions} />
    </ProjectsMessages>
  )
}

function Dialog({ model, actions }: { model: LinkDialogModel; actions?: LinkDialogActions | undefined }) {
  const { t, say, shared } = useWords(LINKED_NS)
  const search = useT('search')
  const [q, setQ] = useState(model.q)
  useEffect(() => setQ(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  // The search follows the typing (300 ms after the last key), never on every key.
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onQuery?.(q), 300)
    return () => clearTimeout(timer)
  }, [q])

  const noteHeld = noteProblem(model.note)
  const submitHeld = model.offline ? shared('held.offline') : model.picked ? (noteHeld ? say(noteHeld) : null) : t('link.pickFirst')
  const results = model.results

  return (
    <Modal
      open
      size="md"
      title={t('link.title', { project: model.project })}
      subtitle={say(model.scope)}
      onClose={() => actions?.onClose?.()}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('link.cancel')}</Button>
          <Button variant="primary" heldReason={submitHeld} disabled={model.busy} onClick={() => actions?.onSubmit?.()}>
            {model.busy ? shared('common.working') : t('link.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-prjl-dialog">
        {model.problem && (
          <Banner tone="danger" title={say(model.problem.title)}>
            {model.problem.body ? <span>{say(model.problem.body)}</span> : null}
          </Banner>
        )}
        <div className="fw-prjl-searchrow">
          <Input
            type="search"
            size="sm"
            className="fw-prjl-search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('link.searchLabel')}
            placeholder={t('link.search')}
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
          <Select size="sm" aria-label={t('link.kind')} value={model.kind ?? ''} onChange={(event) => actions?.onKind?.((event.target.value || null) as ProjectLinkType | null)}>
            <option value="">{t('link.allKinds')}</option>
            {LINK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(typeKey(kind))}
              </option>
            ))}
          </Select>
        </div>

        <div className="fw-prjl-results" role="group" aria-label={t('link.results')} aria-busy={results.status === 'loading' || undefined}>
          {results.status === 'idle' && <p className="fw-prjl-hint">{t('link.idle')}</p>}
          {results.status === 'tooShort' && <p className="fw-prjl-hint">{t('link.tooShort')}</p>}
          {results.status === 'loading' && <p className="fw-prjl-hint" role="status">{t('link.loading')}</p>}
          {results.status === 'error' && (
            <EmptyState
              title={t('link.failed')}
              description={shared(results.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('link.retry')}
                </Button>
              }
            />
          )}
          {results.status === 'ready' && results.items.length === 0 && <p className="fw-prjl-hint">{t('link.none')}</p>}
          {results.status === 'ready' &&
            results.items.map((item) => {
              const picked = model.picked?.recordType === item.recordType && model.picked.recordId === item.recordId
              return (
                <RadioCard
                  key={`${item.recordType}:${item.recordId}`}
                  variant="row"
                  name="fw-prjl-pick"
                  checked={picked}
                  selected={picked}
                  disabled={item.linked}
                  onChange={() => actions?.onPick?.(item)}
                  title={
                    <span className="fw-prjl-candidate">
                      <span className="fw-prjl-num">{item.label}</span>
                      <span className="fw-prjl-kind">{t(typeKey(item.recordType))}</span>
                      {item.statusKey && <Tag tone="neutral">{search(item.statusKey)}</Tag>}
                      {item.linked && <Tag tone="info">{t('link.already')}</Tag>}
                    </span>
                  }
                  description={item.title ?? undefined}
                />
              )
            })}
        </div>

        {model.picked && <p className="fw-prjl-picked">{t('link.picked', { label: model.picked.label })}</p>}

        <Field label={t('link.note')} hint={t('link.noteHint')} error={noteHeld ? say(noteHeld) : undefined}>
          <Input value={model.note} maxLength={PROJECT_LIMITS.linkNote + 10} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

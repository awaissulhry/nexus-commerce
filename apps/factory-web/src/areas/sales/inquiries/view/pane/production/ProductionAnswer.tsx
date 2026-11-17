'use client'

import { useId } from 'react'
import { Factory, RefreshCw } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import type { InquiryRow } from '../../../api'
import { productionCell, productionLate, productionTone, suggestionLine, weekPhrase, type ProductionActions, type ProductionModel, type ProductionView } from '../../../production-answer'
import { useWords } from '../../../parts'
import './production.css'

/**
 * B-TH-290 (threads plan TH-9; on B-TH-094; O-SAL-INQ-LIST.list-F10, .pane-head-F07, .pane-facts): production's answer where Incoming
 * shows it — the list's Production cell, row 1's chip (absent until production answered; OK green, "not before week 14" amber; a
 * click opens it in Details) and the Production section of Details, where planning or the production manager types it: OK or not
 * before a week (this week or a later one), planning's suggestion offered from its promise read (nothing written until Save), the
 * answer taken back. Office only (W37): never part of a portal page. Draws its model; the container reads and writes.
 */

/** The list's Production cell: the answer in the column's words, "3 weeks after the wanted date" beside a late one; '—' unanswered. */
export function ProductionCell({ row, today }: { row: Pick<InquiryRow, 'production'>; today: string }) {
  const { say } = useWords()
  const view = row.production ?? null
  const phrase = productionCell(view, today)
  if (!view || !phrase) return <span className="fw-inq-hint">—</span>
  const late = say(productionLate(view))
  return (
    <span className="fw-prod-cell" title={late ?? undefined}>
      <Pill tone={productionTone(view)}>{say(phrase)}</Pill>
      {late && <span className="fw-inq-hint fw-inq-amber">{late}</span>}
    </span>
  )
}

/** The chip on row 1 ("Production: not before week 14"): absent until production answered; a click opens the answer in Details. */
export function ProductionChip({ view, onOpen }: { view: ProductionView | null | undefined; onOpen?: () => void }) {
  const { t, locale, when } = useWords()
  if (!view) return null
  const by = view.answeredBy ? t('production.by', { name: view.answeredBy.name, when: when(view.answeredAt) }) : t('production.byNobody', { when: when(view.answeredAt) })
  return (
    <Pill tone={productionTone(view)} title={`${by} · ${t('production.chipHint')}`} onClick={onOpen} aria-label={`${view.words[locale]} · ${t('production.chipHint')}`}>
      {view.words[locale]}
    </Pill>
  )
}

/**
 * Details › Production: the answer as it is (with who and when, and how late against the wanted date) or "not answered yet"; for who
 * types it, Answer / Change (held with why on a closed request) and the editor in place; for everyone else, who types it.
 */
export function ProductionSection({ model, actions, id }: { model: ProductionModel; actions?: ProductionActions; id: string }) {
  const { t, say, locale, when } = useWords()
  const current = model.current
  const late = say(productionLate(current))
  const held = say(model.held)
  return (
    <section className="fw-rp-sec fw-prod" id={id} aria-label={t('production.title')} tabIndex={-1}>
      <div className="fw-rp-sec-head">
        <h3 className="fw-rp-h3">
          <Factory size={13} aria-hidden /> {t('production.title')}
        </h3>
        {model.answers && !model.editor && (
          <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onOpen?.()}>
            {current ? t('production.change') : t('production.answer')}
          </Button>
        )}
      </div>
      {current ? (
        <div className="fw-prod-now">
          <Pill tone={productionTone(current)}>{current.words[locale]}</Pill>
          <p className="fw-inq-hint">{current.answeredBy ? t('production.by', { name: current.answeredBy.name, when: when(current.answeredAt) }) : t('production.byNobody', { when: when(current.answeredAt) })}</p>
          {late && <p className="fw-inq-hint fw-inq-amber">{late}</p>}
        </div>
      ) : (
        <p className="fw-inq-hint">{t('production.none')}</p>
      )}
      {!model.answers && <p className="fw-inq-hint">{t('production.whoTypes')}</p>}
      {model.editor && <Editor model={model} actions={actions} />}
      <p className="fw-inq-hint fw-prod-office">{t('production.officeOnly')}</p>
    </section>
  )
}

function Editor({ model, actions }: { model: ProductionModel; actions?: ProductionActions }) {
  const { t, say } = useWords()
  const editor = model.editor!
  const weekId = useId()
  const draft = editor.draft
  const chosen = draft.answer ?? ''
  const suggestion = editor.suggestion
  return (
    <div className="fw-prod-editor" role="group" aria-label={t('production.editor')}>
      <SegmentedControl
        ariaLabel={t('production.kind.label')}
        size="sm"
        wrap
        value={chosen}
        disabled={editor.busy}
        options={[
          { value: 'OK', label: t('production.kind.OK') },
          { value: 'NOT_BEFORE', label: t('production.kind.NOT_BEFORE') },
        ]}
        onChange={(value) => actions?.onDraft?.({ answer: value === 'OK' ? 'OK' : 'NOT_BEFORE' })}
      />
      {draft.answer === 'NOT_BEFORE' && (
        <Field label={t('production.week')} htmlFor={weekId} hint={t('production.weekHint')}>
          <Select id={weekId} size="sm" value={draft.week} disabled={editor.busy} onChange={(event) => actions?.onDraft?.({ week: event.target.value })}>
            <option value="">{t('production.weekPick')}</option>
            {editor.weeks.map((week) => (
              <option key={week.key} value={week.key}>
                {say(weekPhrase(week, model.today))}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {suggestion && (
        <div className="fw-prod-suggest" aria-live="polite">
          <div className="fw-rp-sec-head">
            <span className="fw-prod-suggest-title">{t('production.suggest.title')}</span>
            {suggestion.status !== 'loading' && (
              <Button size="sm" variant="quiet" disabled={editor.busy} onClick={() => actions?.onSuggest?.(editor.plantId)}>
                <RefreshCw size={12} aria-hidden /> {t('production.suggest.again')}
              </Button>
            )}
          </div>
          {suggestion.status === 'loading' ? (
            <>
              <p className="fw-inq-hint" role="status">
                {t('production.suggest.asking')}
              </p>
              <Skeleton height={28} />
            </>
          ) : suggestion.status === 'ready' ? (
            <Suggestion model={model} actions={actions} />
          ) : (
            <p className="fw-inq-hint">{suggestion.status === 'error' ? t(suggestion.problem) : t('production.suggest.failed')}</p>
          )}
          {editor.plants && editor.plants.length > 1 && (
            <Field label={t('production.suggest.plant')}>
              <Select size="sm" value={editor.plantId ?? ''} disabled={editor.busy || suggestion.status === 'loading'} onChange={(event) => event.target.value && actions?.onSuggest?.(event.target.value)}>
                <option value="">{t('production.suggest.plantPick')}</option>
                {editor.plants.map((plant) => (
                  <option key={plant.id} value={plant.id}>
                    {plant.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      {!suggestion && <p className="fw-inq-hint">{t('production.suggest.noRight')}</p>}
      {editor.notice && <Banner tone={editor.notice.tone}>{say(editor.notice)}</Banner>}
      <div className="fw-inq-actions">
        <Button size="sm" variant="primary" disabled={editor.busy} onClick={() => actions?.onSave?.()}>
          {t('production.save')}
        </Button>
        {model.current && (
          <Button size="sm" variant="quiet" disabled={editor.busy} onClick={() => actions?.onTakeBack?.()}>
            {t('production.takeBack')}
          </Button>
        )}
        <Button size="sm" variant="quiet" disabled={editor.busy} onClick={() => actions?.onClose?.()}>
          {t('production.cancel')}
        </Button>
      </div>
    </div>
  )
}

/** Planning's answer in our words: its suggestion, the lines it dated, the lines it could not (each with why); "Use this" fills the draft. */
function Suggestion({ model, actions }: { model: ProductionModel; actions?: ProductionActions }) {
  const { t, say, locale } = useWords()
  const editor = model.editor!
  if (editor.suggestion?.status !== 'ready') return null
  const value = editor.suggestion.value
  const usable = value.suggestion.answer !== null
  const same = usable && editor.draft.answer === value.suggestion.answer && (value.suggestion.answer === 'OK' || editor.draft.week === value.suggestion.week)
  return (
    <div className="fw-prod-suggestion">
      <p className="fw-inq-text">{value.suggestion.words[locale]}</p>
      {value.site && <p className="fw-inq-hint">{t('production.suggest.at', { plant: value.site.name })}</p>}
      {(value.lines.length > 0 || value.leftOut.length > 0) && (
        <ul className="fw-prod-lines">
          {value.lines.map((line) => (
            <li key={line.lineId}>{say(suggestionLine(line))}</li>
          ))}
          {value.leftOut.map((line) => (
            <li key={line.lineId} className="fw-inq-hint">
              {t('production.suggest.leftOut', { seq: line.seq, why: line.why[locale] })}
            </li>
          ))}
        </ul>
      )}
      {usable && (
        <Button size="sm" variant="secondary" disabled={editor.busy || same} onClick={() => actions?.onUseSuggestion?.()}>
          {same ? t('production.suggest.used') : t('production.suggest.use')}
        </Button>
      )}
    </div>
  )
}

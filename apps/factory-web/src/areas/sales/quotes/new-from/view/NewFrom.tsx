'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NS, type Words } from '../../record/lines-depth/model'
import { useDepthWords } from '../../record/lines-depth/words'
import { leftOutWords, openLines, type LinePick, type NewFromKind, type NewFromModel, type StartDone } from '../model'
import '../../record/lines-depth/depth.css'

export interface NewFromActions {
  onTemplateSearch?: (companyId: string, query: string) => void
  onTemplatePick?: (templateId: string) => void
  onLinePick?: (lineId: string, pick: Partial<LinePick>) => void
  onInquiryPick?: (inquiryId: string) => void
}

const Depth = ({ children }: { children: ReactNode }) => <WithMessages namespaces={['sales', DEPTH_NS]}>{children}</WithMessages>

/** New quote › Start from: Template (W2b) or Inquiry (W2b), as RadioCards beside W1's Blank and Past quote. */
export function StartFromOption({ kind, model, onChoose }: { kind: NewFromKind; model: NewFromModel; onChoose?: (kind: NewFromKind) => void }) {
  return (
    <Depth>
      <Option kind={kind} model={model} onChoose={onChoose} />
    </Depth>
  )
}

function Option({ kind, model, onChoose }: { kind: NewFromKind; model: NewFromModel; onChoose?: (kind: NewFromKind) => void }) {
  const { t } = useDepthWords()
  const held = kind === 'inquiry' && !model.inquiries.view ? t('from.held.noInquiries') : null
  return <RadioCard name="fw-q-start-from" value={kind} checked={model.active === kind} selected={model.active === kind} disabled={!!held} onChange={() => onChoose?.(kind)} title={t(`from.option.${kind}`)} description={held ?? t(`from.optionBody.${kind}`)} />
}

/**
 * What the chosen start asks (design pop:quotes.new "Start from"): a template of this company or of every company (its
 * lines whose colourway or pieces are chosen at use: pick them, or leave the line out), or one of the customer's open
 * inquiries (its lines become the quote's, the inquiry is marked quoted).
 */
export function NewFromBody({ model, companyId, actions }: { model: NewFromModel; companyId: string; actions?: NewFromActions }) {
  return <Depth>{model.active === 'template' ? <TemplateStart model={model} companyId={companyId} actions={actions} /> : model.active === 'inquiry' ? <InquiryStart model={model} actions={actions} /> : null}</Depth>
}

function TemplateStart({ model, companyId, actions }: { model: NewFromModel; companyId: string; actions?: NewFromActions }) {
  const { t, sales } = useDepthWords()
  const pick = model.template
  const [query, setQuery] = useState(pick?.query ?? '')
  const typed = useRef(false)
  const search = useRef(actions?.onTemplateSearch)
  search.current = actions?.onTemplateSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(companyId, query), 250)
    return () => clearTimeout(timer)
  }, [query, companyId])
  if (!pick) return null
  const template = pick.template?.status === 'ready' ? pick.template.value : null
  const open = template ? openLines(template) : []
  return (
    <div className="fw-q-stack">
      <Field label={t('from.templateSearch')} hint={t('from.templateHint')}>
        <Input
          value={query}
          type="search"
          autoComplete="off"
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      </Field>
      {pick.problem ? (
        <Banner tone="danger" title={sales(pick.problem)} />
      ) : (
        <fieldset className="fw-q-choices">
          <legend className="fw-q-legend" aria-live="polite">
            {pick.results === null ? t('common.loading') : pick.results.length === 0 ? t('from.noTemplates') : t('from.templatesFound', { count: pick.results.length })}
          </legend>
          {pick.results === null && <Spinner size={14} />}
          {(pick.results ?? []).map((row) => (
            <RadioCard
              key={row.id}
              variant="row"
              name="fw-qd-template"
              value={row.id}
              checked={pick.chosenId === row.id}
              selected={pick.chosenId === row.id}
              onChange={() => actions?.onTemplatePick?.(row.id)}
              title={row.name}
              description={
                <span className="fw-q-tags">
                  <span className="fw-q-hint">{t('from.templateLine', { lines: row.lineCount, used: row.used })}</span>
                  <Tag tone={row.companyId === null ? 'info' : 'neutral'}>{row.company ? row.company.code : t('tpl.everyCompany')}</Tag>
                  {row.sections.length > 0 && <span className="fw-q-hint">{row.sections.join(' · ')}</span>}
                </span>
              }
            />
          ))}
        </fieldset>
      )}
      {pick.template?.status === 'loading' && (
        <p className="fw-q-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      )}
      {pick.template?.status === 'error' && <Banner tone="danger" title={sales(pick.template.problem)} />}
      {template && open.length === 0 && <p className="fw-q-hint">{t('from.allSet', { count: template.lines.length })}</p>}
      {template && open.length > 0 && (
        <div className="fw-q-stack">
          <p className="fw-q-hint">{t('from.openLines', { count: open.length })}</p>
          {open.map((line) => {
            const chosen = pick.picks[line.id] ?? { colourwayId: '', sizes: {}, skip: false }
            const style = pick.styles[line.styleId]
            const colourways = style?.colourways.filter((entry) => entry.status === 'ACTIVE') ?? []
            const madeIn = colourways.find((entry) => entry.id === (line.colourwayId ?? chosen.colourwayId))?.offeredSizes ?? null
            // A colourway made in no size yet: the style's sizes are typed, and the start says what it leaves out.
            const offered = madeIn && madeIn.length > 0 ? madeIn : (style?.sizes ?? [])
            return (
              <div key={line.id} className="fw-qd-delivery">
                <div className="fw-qd-delivery-head">
                  <strong>{t('from.lineOf', { line: line.seq, style: line.style.code, colour: line.colourway ? line.colourway.code : t('from.colourAtUse') })}</strong>
                  <Checkbox checked={chosen.skip} onChange={() => actions?.onLinePick?.(line.id, { skip: !chosen.skip })} label={t('from.skip')} />
                </div>
                {!chosen.skip && (
                  <div className="fw-qd-delivery-fields">
                    {line.colourwayId === null && (
                      <Field label={t('from.colourway')}>
                        {style === undefined ? (
                          <Spinner size={14} />
                        ) : (
                          <Select value={chosen.colourwayId} onChange={(event) => actions?.onLinePick?.(line.id, { colourwayId: event.target.value })}>
                            <option value="">{t('from.pickColourway')}</option>
                            {colourways.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.code} · {entry.name}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    )}
                    {line.sizes === null && madeIn !== null && madeIn.length === 0 && <p className="fw-q-hint">{t('from.noneOfferedYet')}</p>}
                    {line.sizes === null && (
                      <div className="fw-qd-delivery-sizes" role="group" aria-label={t('from.piecesOf', { line: line.seq })}>
                        {offered.map((size) => (
                          <Field key={size} label={size}>
                            <Input size="sm" inputMode="numeric" placeholder="0" value={chosen.sizes[size] ?? ''} onChange={(event) => actions?.onLinePick?.(line.id, { sizes: { ...chosen.sizes, [size]: event.target.value } })} />
                          </Field>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <p className="fw-q-hint">{t('from.unfilled')}</p>
        </div>
      )}
    </div>
  )
}

function InquiryStart({ model, actions }: { model: NewFromModel; actions?: NewFromActions }) {
  const { t, sales } = useDepthWords()
  const locale = useLocale()
  const pick = model.inquiry
  if (!model.inquiries.view) return <p className="fw-q-hint">{t('from.held.noInquiries')}</p>
  if (!pick) return null
  if (pick.problem) return <Banner tone="danger" title={sales(pick.problem)} />
  return (
    <fieldset className="fw-q-choices">
      <legend className="fw-q-legend" aria-live="polite">
        {pick.results === null ? t('common.loading') : pick.results.length === 0 ? t('from.noInquiries') : t('from.inquiriesFound', { count: pick.results.length })}
      </legend>
      {pick.results === null && <Spinner size={14} />}
      {(pick.results ?? []).map((row) => (
        <RadioCard
          key={row.id}
          variant="row"
          name="fw-qd-inquiry"
          value={row.id}
          checked={pick.chosenId === row.id}
          selected={pick.chosenId === row.id}
          onChange={() => actions?.onInquiryPick?.(row.id)}
          title={`${row.number} · ${row.summary || row.products.join(', ') || '—'}`}
          description={
            <span className="fw-q-tags">
              <span className="fw-q-hint">{t('from.inquiryLine', { pieces: row.pieces, received: formatDate(row.receivedAt, { locale }) })}</span>
              {row.wantedDate && <Tag tone="info">{t('from.wanted', { date: formatDate(`${row.wantedDate}T12:00:00Z`, { locale }) })}</Tag>}
              {row.products.length > 0 && <span className="fw-q-hint">{row.products.join(' · ')}</span>}
            </span>
          }
        />
      ))}
    </fieldset>
  )
}

/** The receipt of a start that left something out, before the new quote opens. */
export function NewFromDone({ done, onOpen, onClose }: { done: StartDone; onOpen?: (quoteId: string) => void; onClose?: () => void }) {
  return (
    <Depth>
      <Done done={done} onOpen={onOpen} onClose={onClose} />
    </Depth>
  )
}

function Done({ done, onOpen, onClose }: { done: StartDone; onOpen?: (quoteId: string) => void; onClose?: () => void }) {
  const { t, say } = useDepthWords()
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('from.doneTitle', { number: done.number })}
      size="md"
      footer={
        <Button variant="primary" onClick={() => onOpen?.(done.quoteId)}>
          {t('from.open', { number: done.number })}
        </Button>
      }
    >
      <div className="fw-q-dialog">
        <p className="fw-q-hint" role="status">
          {done.lines === null ? t('from.doneBodyInquiry', { number: done.number, from: done.from }) : t('from.doneBody', { number: done.number, from: done.from, count: done.lines })}
        </p>
        <Banner tone="warning" title={t('from.leftTitle', { count: done.leftOut.length })}>
          <ul className="fw-q-list">
            {done.leftOut.map((entry, index) => (
              <li key={`${entry.seq}-${entry.size ?? ''}-${index}`}>{say(leftOutWords(entry))}</li>
            ))}
          </ul>
        </Banner>
        {done.warnings > 0 && <Banner tone="info" title={t('from.warnings', { count: done.warnings })} />}
      </div>
    </Modal>
  )
}

/** The words of a held Create in W1's dialog (its provider holds `sales` only: the depth catalogue is read here). */
export function useHeldWords(): (words: Words | null) => string | null {
  const locale = useLocale()
  const sales = useT('sales')
  const depth = useMemo(() => createTranslator(locale, messagesFor(locale, [DEPTH_NS])[DEPTH_NS] ?? {}), [locale])
  return (words) => (words ? (words.ns === 'sales' ? sales(words.key, words.params) : depth(words.key, words.params)) : null)
}

'use client'

import { useMemo } from 'react'
import { Calculator, CalendarCheck } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { SizeGridEditor } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Combobox, DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { AskAnswer } from '../api'
import { bridgeSetter, bridgeWords, calcHeld, dayWords, groupsWords, sizeCertificateWords, sizeStateKey, warningKey, type Words } from '../model'
import type { CalculatorDialog, PromiseActions, PromiseModel } from '../view-model'
import { sizeGridCopy } from './grid-copy'

const stateTone = (state: AskAnswer['sizes'][number]['state']): 'success' | 'info' | 'danger' | 'warning' | 'neutral' =>
  state === 'FROM_STOCK' ? 'success' : state === 'MAKE' || state === 'STOCK_AND_MAKE' ? 'info' : state === 'NOT_CERTIFIED' ? 'danger' : state === 'NO_DATE' ? 'warning' : 'neutral'

/**
 * The Promise calculator (design planning.promise pop:calc; the band's primary action, or a quote's "Suggest date" with
 * `?quote=`): the style, its colour, the quantity per size (the DS size grid), the wanted day and where it goes → the date and
 * how it is made — the bridge (base lead time + queue at today's load + the material to buy = days → day), per size when sizes
 * differ (S–L 4 Dec, XL 11 Dec), the certificate through the ship date, and what the plan warns of. It writes nothing; "Use on
 * quote (Sales)" puts a quote's suggested date on the quote (W1's own change) when opened from a draft quote one may change.
 */
export function CalculatorModal({ model, actions, words }: { model: PromiseModel; actions?: PromiseActions; words: Words }) {
  const { t } = words
  const calc = model.calculator!
  const quote = calc.quote?.status === 'ready' ? calc.quote.value : null
  const useHeld = !model.controls.quote
    ? t('calc.held.noQuote')
    : calc.quote?.status !== 'ready'
      ? t('calc.held.quoteLoading')
      : !quote?.mayUse
        ? t('calc.held.mayNotUse')
        : !quote.promiseDate
          ? t('calc.held.noDate')
          : calc.used
            ? t('calc.held.used')
            : calc.using
              ? t('held.busy')
              : null
  const heldCalc = calcHeld(calc.form, model.siteId)
  return (
    <Modal
      open
      onClose={() => actions?.onCalculator?.(false)}
      title={t('calc.title')}
      subtitle={quote ? t('calc.forQuote', { quote: quote.quote.number, revision: quote.quote.revision }) : t('calc.subtitle')}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onCalculator?.(false)}>{t('common.close')}</Button>
          <Button heldReason={heldCalc ? t(heldCalc) : calc.style?.status !== 'ready' ? t('calc.held.style') : calc.answer?.status === 'loading' ? t('held.busy') : null} onClick={() => actions?.onCalculate?.()}>
            {calc.answer?.status === 'loading' ? <Spinner size={12} /> : <Calculator size={14} aria-hidden />} {t('calc.ask')}
          </Button>
          <Button variant="primary" heldReason={useHeld} onClick={() => actions?.onUseOnQuote?.()}>
            {calc.using ? <Spinner size={12} /> : <CalendarCheck size={14} aria-hidden />} {t('calc.use')}
          </Button>
        </>
      }
    >
      <div className="fw-pdt-dialog">
        {calc.problem && <Banner tone="danger" title={t(calc.problem)} />}
        {calc.used && <Banner tone="success" title={t('calc.used', { day: dayWords(calc.used.promiseDate, words.locale, true) })} />}
        {model.controls.quote && <QuotePart calc={calc} words={words} />}
        <CalcForm model={model} calc={calc} actions={actions} words={words} />
        <AnswerPart calc={calc} words={words} />
      </div>
    </Modal>
  )
}

function QuotePart({ calc, words }: { calc: CalculatorDialog; words: Words }) {
  const { t, locale } = words
  if (!calc.quote || calc.quote.status === 'loading') return <Skeleton height={60} />
  if (calc.quote.status === 'error') return <Banner tone="danger" title={t('calc.quoteError')}>{t(calc.quote.problem)}</Banner>
  const quote = calc.quote.value
  return (
    <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-calc-quote">
      <h3 id="fw-pdt-calc-quote" className="fw-pdt-h3">
        {t('calc.quoteTitle', { quote: quote.quote.number })}
      </h3>
      <p className="fw-pdt-text">{quote.promiseDate ? t('calc.quoteDate', { day: dayWords(quote.promiseDate, locale, true) }) : t('calc.quoteNoDate')}</p>
      <SummaryTable
        label={t('calc.quoteTitle', { quote: quote.quote.number })}
        columns={[t('calc.col.line'), t('calc.col.style'), t('calc.col.date'), t('calc.col.sizes')]}
        stackOnPhone
        rows={quote.lines.map((line) => ({
          id: line.lineId,
          cells: [String(line.seq), `${line.answer.style.code} · ${line.answer.colourway.name}`, line.answer.date ? dayWords(line.answer.date, locale, true) : t('calc.notPromised'), groupsWords(line.answer.groups, words)],
        }))}
      />
      {quote.skipped.length > 0 && <p className="fw-pdt-hint">{t('calc.skipped', { count: quote.skipped.length })}</p>}
    </section>
  )
}

function CalcForm({ model, calc, actions, words }: { model: PromiseModel; calc: CalculatorDialog; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const style = calc.style?.status === 'ready' ? calc.style.value : null
  const colourways = (style?.colourways ?? []).filter((entry) => entry.status === 'ACTIVE')
  const colourway = colourways.find((entry) => entry.id === calc.form.colourwayId) ?? null
  const options = calc.styles.status === 'ready' ? calc.styles.value.map((entry) => ({ value: entry.id, label: `${entry.code} · ${entry.name}` })) : []
  const copy = useMemo(() => sizeGridCopy(t, t('calc.quantities')), [t])
  return (
    <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-calc-ask">
      <h3 id="fw-pdt-calc-ask" className="fw-pdt-h3">
        {t('calc.askTitle')}
      </h3>
      {calc.styles.status === 'error' ? (
        <Banner tone={calc.styles.problem === 'error.noStyles' ? 'info' : 'danger'} title={t(calc.styles.problem === 'error.noStyles' ? 'calc.noStyles' : 'calc.stylesError')} />
      ) : null}
      <div className="fw-pdt-form-grid">
        <Field label={t('calc.style')} required>
          {calc.styles.status === 'loading' ? (
            <Skeleton height={32} />
          ) : (
            <div>
              <span id="fw-pdt-calc-style-label" className="nds-vh">
                {t('calc.style')}
              </span>
              <Combobox options={options} value={calc.form.styleId || undefined} placeholder={t('calc.stylePick')} labelledBy="fw-pdt-calc-style-label" onChange={(value) => actions?.onCalcStyle?.(value)} />
            </div>
          )}
        </Field>
        <Field label={t('calc.colour')} required>
          <Select value={calc.form.colourwayId} aria-label={t('calc.colour')} disabled={!style} onChange={(event) => actions?.onCalcForm?.({ colourwayId: event.target.value, quantities: {} })}>
            <option value="">{style ? t('calc.colourPick') : t('calc.colourFirst')}</option>
            {colourways.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('calc.wanted')} hint={t('calc.wantedHint')}>
          <DateField value={calc.form.wanted} min={model.list.status === 'ready' ? model.list.value.today : undefined} clearable ariaLabel={t('calc.wanted')} onChange={(value) => actions?.onCalcForm?.({ wanted: value })} />
        </Field>
        <Field label={t('calc.country')} hint={t('calc.countryHint')}>
          <Input value={calc.form.country} maxLength={3} placeholder="IT" onChange={(event) => actions?.onCalcForm?.({ country: event.target.value })} />
        </Field>
      </div>
      {calc.style?.status === 'loading' && <Skeleton height={80} />}
      {calc.style?.status === 'error' && <Banner tone="danger" title={t('calc.styleError')}>{t(calc.style.problem)}</Banner>}
      {style && colourway && (
        <SizeGridEditor
          layout="auto"
          colours={[{ key: colourway.id, label: colourway.name, offered: colourway.offeredSizes.length > 0 ? colourway.offeredSizes : style.sizes }]}
          sizes={style.sizes.map((size) => ({ key: size, label: size }))}
          value={{ [colourway.id]: calc.form.quantities }}
          max={100_000}
          onChange={(next) => actions?.onCalcForm?.({ quantities: next[colourway.id] ?? {} })}
          caption={t('calc.quantities')}
          locale={INTL_LOCALE[locale]}
          copy={copy}
        />
      )}
      {style && !colourway && <p className="fw-pdt-hint">{colourways.length === 0 ? t('calc.noColours') : t('calc.colourFirstHint')}</p>}
    </section>
  )
}

function AnswerPart({ calc, words }: { calc: CalculatorDialog; words: Words }) {
  const { t, locale } = words
  if (!calc.answer) return <p className="fw-pdt-hint">{t('calc.empty')}</p>
  if (calc.answer.status === 'loading') return <Skeleton height={120} />
  if (calc.answer.status === 'error') return <EmptyState title={t('calc.answerError')} description={t(calc.answer.problem)} />
  const { answer, market } = calc.answer.value
  const bridge = bridgeWords(answer.bridge, bridgeSetter(answer), words)
  const day = (value: string | null) => (value ? dayWords(value, locale, true) : t('calc.notPromised'))
  return (
    <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-calc-answer" aria-live="polite">
      <h3 id="fw-pdt-calc-answer" className="fw-pdt-h3">
        {t('calc.answerTitle')}
      </h3>
      <div className="fw-pdt-answer">
        <span className="fw-pdt-answer-day">{answer.date ? dayWords(answer.date, locale, true) : t('calc.noAnswer')}</span>
        {answer.wantedDate ? <Pill tone={answer.meetsWanted ? 'success' : 'warning'}>{answer.meetsWanted ? t('calc.meets', { day: dayWords(answer.wantedDate, locale) }) : t('calc.late', { count: answer.daysLate ?? 0, day: dayWords(answer.wantedDate, locale) })}</Pill> : null}
        {!answer.complete ? <Pill tone="danger">{t('calc.incomplete')}</Pill> : null}
      </div>
      {bridge && (
        <p className="fw-pdt-text">
          <b>{t('calc.bridge')}</b> {bridge}
        </p>
      )}
      {answer.groups.length > 1 && (
        <p className="fw-pdt-text">
          <b>{t('calc.perSize')}</b> {groupsWords(answer.groups, words)}
        </p>
      )}
      {market && <p className="fw-pdt-hint">{t('calc.market', { market: market.name })}</p>}
      <SummaryTable
        label={t('calc.sizesTitle')}
        columns={[t('calc.col.size'), t('calc.col.quantity'), t('calc.col.stock'), t('calc.col.make'), t('calc.col.state'), t('calc.col.date'), t('calc.col.certificate')]}
        align={['left', 'right', 'right', 'right', 'left', 'left', 'left']}
        stackOnPhone
        rows={answer.sizes.map((size) => ({
          id: size.size,
          cells: [size.size, String(size.quantity), String(size.fromStock), String(size.toMake), <Pill key="state" tone={stateTone(size.state)}>{t(sizeStateKey(size.state))}</Pill>, day(size.date), sizeCertificateWords(size, words)],
        }))}
      />
      {answer.steps.length > 0 && (
        <details className="fw-pdt-details">
          <summary>{t('calc.steps', { count: answer.steps.length })}</summary>
          <ol className="fw-pdt-list">
            {answer.steps.map((step) => (
              <li key={step.seq}>
                {step.name} — {step.outside ? t('calc.outside') : (step.lane?.name ?? t('calc.noLane'))} · {dayWords(step.start, locale)}–{dayWords(step.finish, locale)}
              </li>
            ))}
          </ol>
        </details>
      )}
      {answer.warnings.length > 0 && (
        <Banner tone="warning" title={t('calc.warnings')}>
          <ul className="fw-pdt-list">
            {[...new Set(answer.warnings.map((warning) => warningKey(warning.code)))].map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Banner>
      )}
    </section>
  )
}

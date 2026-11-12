'use client'

import { useState } from 'react'
import { Printer, Tag as TagIcon } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { Button, Input, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Phrase } from '../../../../_shared/stock/model'
import { normalizeLabelCode } from '@nexus/factory-domain/inventory/locations-depth/labels'
import type { PlaceLabel, PlaceView } from '../api'
import { binLabelLayout, labelCodeOf, labelCodeProblem, labelRefusalOf, printStateOf, type Loaded } from '../model'
import { DEPTH_WORDS } from './DepthDialogs'

export interface LabelCodeActions {
  /** Gives the place its label code: a typed one, the suggested one (undefined), or none (null). */
  onSaveLabelCode?: (place: PlaceView, code: string | null | undefined) => Promise<{ problem: Phrase | null; printed?: number }>
}

const JOB_TONE = { QUEUED: 'neutral', SENT: 'info', PRINTED: 'success', FAILED: 'danger' } as const

/**
 * Location › Labels (design warehouse.locations rec:Location/labels, SCM-178): the bin label to scale as it prints (the
 * DS LabelPreview: heading, the place's name, its code as Code 128 bars with the code under them, the site, path and kind
 * in the label's language) with the newest print job's state, Print / Reprint (a label printer of the site, or the PDF in
 * a new tab); the code the label carries — its own, or the one it gets (`<site>-<code>`) — given or changed with a warning
 * that labels already printed with the old code no longer scan; and the print history. An outside or transit place, or an
 * archived one, carries no label (said in words). Fetches nothing.
 */
export function LabelsTab({
  place,
  siteCode,
  places,
  label,
  canManage,
  canPrint,
  timeZone,
  codeDraft,
  actions,
  onPrint,
  onRetry,
}: {
  place: PlaceView
  siteCode: string
  places: readonly PlaceView[]
  label: Loaded<PlaceLabel> | null
  canManage: boolean
  canPrint: boolean
  timeZone: string
  codeDraft?: string
  actions?: LabelCodeActions
  onPrint?: () => void
  onRetry?: () => void
}) {
  const t = useT(DEPTH_WORDS)
  const s = useT('stock')
  const locale = useLocale()
  const where = { locale, timeZone }
  const refusal = labelRefusalOf(place)
  const current = labelCodeOf(place, siteCode)
  const [typed, setTyped] = useState(codeDraft ?? place.labelCode ?? current.code)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ problem: Phrase | null; printed?: number } | null>(null)

  if (refusal) return <EmptyState icon={<TagIcon size={22} aria-hidden />} title={t(refusal)} description={t('wd.loc.label.noneBody')} />
  if (!label || label.status === 'loading')
    return (
      <div className="fw-wd-split" aria-busy="true">
        <Skeleton height={240} />
        <Skeleton height={240} />
      </div>
    )
  if (label.status === 'error')
    return (
      <Banner
        tone="danger"
        title={s(label.problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {s('problem.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  const value = label.value
  const last = value.jobs[0] ?? null
  const problem = labelCodeProblem(typed, places, place.id)
  const changed = normalizeLabelCode(typed) !== (place.labelCode ?? '')
  const save = async (code: string | null | undefined) => {
    if (!actions?.onSaveLabelCode || busy) return
    setBusy(true)
    setAnswer(await actions.onSaveLabelCode(place, code))
    setBusy(false)
  }
  return (
    <div className="fw-wd-split">
      <Card padded>
        <section className="fw-wd-stack" aria-label={t('wd.loc.label.previewTitle')}>
          <h2 className="fw-lc-card-title">{t('wd.loc.label.previewTitle')}</h2>
          <LabelPreview
            layout={binLabelLayout(value.label, t('wd.loc.label.labelName', { code: value.code }))}
            scale={4}
            codeLabel={(code) => t('wd.loc.label.barcode', { code })}
            invalidCodeLabel={(code) => t('wd.loc.label.invalid', { code })}
            {...(last ? { print: printStateOf(last, { state: t(`wd.loc.job.${last.state}`), detail: `${last.printerCode} · ${formatDateTime(last.printedAt ?? last.at, where)}` }) } : {})}
            actions={
              <Button size="sm" variant="primary" onClick={() => onPrint?.()}>
                <Printer size={13} aria-hidden /> {t(last ? 'wd.loc.label.reprint' : 'wd.loc.label.print')}
              </Button>
            }
          />
          <p className="fw-stk-hint">{value.suggested ? t('wd.loc.label.suggestedNote', { code: value.code }) : t('wd.loc.label.ownNote')}</p>
          {!canPrint && <p className="fw-stk-hint">{t('wd.loc.print.noRightPdf')}</p>}
        </section>
      </Card>
      <Card padded>
        <section className="fw-wd-stack" aria-label={t('wd.loc.label.codeTitle')}>
          <h2 className="fw-lc-card-title">{t('wd.loc.label.codeTitle')}</h2>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('wd.loc.label.codeNow'), value: place.labelCode ? <span className="fw-lc-code">{place.labelCode}</span> : t('wd.loc.label.none'), hint: place.labelCode ? undefined : t('wd.loc.label.getsCode', { code: current.code }) },
              { label: t('wd.loc.label.placeCode'), value: <span className="fw-lc-code">{place.code}</span> },
            ]}
          />
          {answer?.problem && <Banner tone="danger" title={t(answer.problem.key, answer.problem.params)} />}
          {answer && !answer.problem && <Banner tone={answer.printed ? 'warning' : 'success'} title={answer.printed ? t('wd.loc.label.savedPrinted', { count: answer.printed }) : t('wd.loc.label.saved')} />}
          {canManage ? (
            <form
              className="fw-wd-stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                if (!problem && changed) void save(normalizeLabelCode(typed))
              }}
            >
              <Field label={t('wd.loc.label.codeField')} hint={t('wd.loc.label.codeHint')} error={changed && problem ? t(problem) : undefined}>
                <Input value={typed} maxLength={64} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value.toUpperCase())} />
              </Field>
              {place.labelCode && changed && <p className="fw-stk-hint fw-st-warning">{t('wd.loc.label.oldCode')}</p>}
              <div className="fw-wd-row">
                <Button size="sm" variant="primary" type="submit" heldReason={busy ? t('wd.loc.busy') : !changed ? t('wd.loc.label.code.same') : problem ? t(problem) : null}>
                  {t('wd.loc.label.saveCode')}
                </Button>
                {!place.labelCode && (
                  <Button size="sm" heldReason={busy ? t('wd.loc.busy') : null} onClick={() => void save(undefined)}>
                    {t('wd.loc.label.giveSuggested', { code: current.code })}
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <p className="fw-stk-hint">{t('wd.loc.held.noManage')}</p>
          )}
          <h3 className="fw-wd-h4">{t('wd.loc.label.history')}</h3>
          {value.jobs.length === 0 ? (
            <p className="fw-st-sub">{t('wd.loc.label.neverPrinted')}</p>
          ) : (
            <ul className="fw-wd-moves">
              {value.jobs.map((job) => (
                <li key={job.jobId}>
                  <span className="fw-st-num">{formatDateTime(job.at, where)}</span>
                  <span>{job.printerCode}</span>
                  <span>{t('wd.loc.label.copies', { count: job.copies })}</span>
                  <Pill tone={JOB_TONE[job.state]}>{t(`wd.loc.job.${job.state}`)}</Pill>
                  {job.state === 'FAILED' && job.lastError && <span className="fw-wd-muted">{t('wd.loc.label.failedHint')}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card>
    </div>
  )
}

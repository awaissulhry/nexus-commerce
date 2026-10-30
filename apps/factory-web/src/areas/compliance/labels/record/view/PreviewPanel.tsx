'use client'

import { ArrowDownToLine } from 'lucide-react'
import { Banner, Card, DateField, Disclosure, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { CheckList, type CheckLine } from '../../../../quality/_shared/parts'
import type { LabelDetail, LabelIssue, PreviewAsk, Rendered } from '../../api'
import { checkRows, familyOf, languagesTyped, PASSED_FAMILIES, sheetSize, type CheckFamily } from '../../model'
import { LabelSheet } from '../../view/parts'
import type { LabelRecordActions, LabelRecordModel } from '../../view-model'

/**
 * The builder's right side (design lb-builder preview + lb-checks): which garment the preview is drawn for (colourway,
 * size, the buyer's languages, the day of the certificate check), the label to scale — the browser's own render while
 * the draft has unsaved changes, else the server's — with each value's source in words and how it fits, then the rule
 * checks: what keeps it from ACTIVE (and what is only noted), each in our words with the API's sentence under it and a
 * link to the field to fix; and what this one garment's label could not print with (the certificate on that day…).
 */
export function PreviewPanel({ detail, model, actions, label, activation, warnings, local }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; label: Rendered | null; activation: readonly LabelIssue[]; warnings: readonly LabelIssue[]; local: boolean }) {
  const locale = useLocale()
  const t = useT('labels')
  const q = useT('quality')
  const draft = model.draft
  const width = sheetSize(draft?.widthMm ?? detail.widthMm, 50)
  const height = sheetSize(draft?.heightMm ?? detail.heightMm, 80)
  const ask = model.ask
  const style = model.style
  const setAsk = (patch: Partial<PreviewAsk>) => actions?.onAsk?.({ ...ask, ...patch })
  const preview = model.preview.value
  const cell = preview?.cell ?? null

  // What stops this one garment's label (the cell), beyond the template's own activation checks.
  const cellOnly = label ? label.problems.filter((issue) => ['certificate', 'class', 'bodyMeasures', 'languages', 'status', 'batch', 'style'].includes(familyOf(issue.path)) && !activation.some((entry) => entry.path === issue.path)) : []

  return (
    <div className="fw-lb-side">
      <Card padded>
        <section className="fw-q-section" aria-labelledby="lb-preview">
          <div className="fw-q-section-head">
            <div className="fw-q-section-title">
              <h2 id="lb-preview">{t('preview.title')}</h2>
              <p className="fw-q-hint">{local ? t('preview.local') : t('preview.server')}</p>
            </div>
            <div className="fw-q-actions">
              <Button size="sm" onClick={() => actions?.onPrintSheet?.()} heldReason={model.preview.value ? null : t('held.noPreview')}>
                <ArrowDownToLine size={14} aria-hidden /> {t('preview.sheet')}
              </Button>
            </div>
          </div>
          <div className="fw-lb-ask">
            {style ? (
              <>
                <Field label={t('preview.colourway')}>
                  <Select size="sm" value={ask.colourwayId ?? cell?.colourwayId ?? ''} onChange={(event) => setAsk({ colourwayId: event.target.value || null })}>
                    {style.colourways.length === 0 && <option value="">{t('preview.noColourway')}</option>}
                    {style.colourways.map((colourway) => (
                      <option key={colourway.id} value={colourway.id}>
                        {colourway.code} · {colourway.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('preview.size')}>
                  <Select size="sm" value={ask.size ?? cell?.size ?? ''} onChange={(event) => setAsk({ size: event.target.value || null })}>
                    {style.sizes.length === 0 && <option value="">{t('preview.noSize')}</option>}
                    {style.sizes.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : (
              <p className="fw-q-hint fw-lb-ask-wide">{cell ? t('preview.cell', { style: cell.styleCode, colourway: preview?.values.colourway?.code ?? '—', size: cell.size ?? '—' }) : t('preview.cellDefault')}</p>
            )}
            <Field label={t('preview.market')} hint={t('preview.marketHint')}>
              <Input size="sm" placeholder={t('preview.marketPlaceholder')} defaultValue={(ask.languages ?? []).join(', ')} onBlur={(event) => setAsk({ languages: languagesTyped(event.target.value) })} />
            </Field>
            <Field label={t('preview.date')} hint={t('preview.dateHint')}>
              {/* The DS date picker (a native date input is not used in the office). */}
              <DateField value={ask.date ?? model.today} onChange={(value) => setAsk({ date: value || null })} locale={locale === 'it' ? 'it-IT' : 'en-GB'} clearable={false} />
            </Field>
          </div>

          {model.preview.problem ? (
            <Banner
              tone={model.preview.problem === 'preview.needStyle' ? 'info' : 'warning'}
              title={model.preview.problem === 'preview.needStyle' ? t('preview.noStyleTitle') : t('preview.failed')}
              action={
                model.preview.problem === 'preview.needStyle' ? undefined : (
                  <Button size="sm" onClick={() => actions?.onRetryPreview?.()}>
                    {q('common.retry')}
                  </Button>
                )
              }
            >
              {model.preview.problem.startsWith('preview.') ? t(model.preview.problem) : q(model.preview.problem)}
            </Banner>
          ) : !label ? (
            <div aria-busy="true" className="fw-q-stack">
              <p className="fw-q-loading" role="status">
                <Spinner size={14} /> {t('preview.loading')}
              </p>
              <Skeleton height={260} width={200} />
            </div>
          ) : (
            <>
              <LabelSheet label={label} widthMm={width} heightMm={height} />
              <FitLine label={label} />
              <Sources label={label} />
            </>
          )}
        </section>
      </Card>

      <Card padded>
        <section className="fw-q-section" aria-labelledby="lb-checks" id="lb-checks-section">
          <div className="fw-q-section-head">
            <div className="fw-q-section-title">
              <h2 id="lb-checks">{t('checks.title')}</h2>
              <p className="fw-q-hint">{detail.status === 'DRAFT' ? (local ? t('checks.introLocal') : t('checks.intro')) : t('checks.introFrozen')}</p>
            </div>
            {detail.status === 'DRAFT' && <Tag tone={activation.length === 0 ? 'success' : 'warning'}>{activation.length === 0 ? t('checks.allPass') : t('checks.count', { count: activation.length })}</Tag>}
          </div>
          <ChecksList problems={activation} warnings={warnings} />
          {cellOnly.length > 0 && (
            <>
              <h3 className="fw-lb-h3">{t('checks.cellTitle', { cell: cell ? `${preview?.values.colourway?.code ?? '—'} ${cell.size ?? '—'}` : '—' })}</h3>
              <p className="fw-q-hint">{t('checks.cellIntro')}</p>
              <CheckList
                label={t('checks.cellTitle', { cell: '' })}
                checks={cellOnly.map((issue, index) => ({ id: `cell-${index}`, state: 'OPEN', name: t(`family.${familyOf(issue.path)}`), text: <CheckText family={familyOf(issue.path)} message={issue.message} /> }))}
              />
            </>
          )}
        </section>
      </Card>
    </div>
  )
}

function CheckText({ family, message }: { family: CheckFamily; message: string }) {
  const t = useT('labels')
  return (
    <span className="fw-lb-checktext">
      <span>{t(`problem.${family}`)}</span>
      <span className="fw-q-hint fw-lb-api" lang="en">
        {message}
      </span>
    </span>
  )
}

/** The rule checks: each family once — open (with every sentence) or passed — then the notes (warnings). */
export function ChecksList({ problems, warnings }: { problems: readonly LabelIssue[]; warnings: readonly LabelIssue[] }) {
  const t = useT('labels')
  const rows = checkRows(problems, warnings)
  const open = rows.filter((row) => row.blocking)
  const notes = rows.filter((row) => !row.blocking)
  const failing = new Set(open.map((row) => row.family))
  const lines: CheckLine[] = [
    ...open.map((row) => ({
      id: row.id,
      state: 'OPEN' as const,
      name: t(`family.${row.family}`),
      text: <CheckText family={row.family} message={row.message} />,
      fix: row.section ? (
        <a className="fw-q-link" href={`#${row.section}`}>
          {t('checks.goToField')}
        </a>
      ) : (
        t(`fixElsewhere.${row.family === 'style' || row.family === 'class' ? 'style' : row.family === 'certificate' ? 'certificate' : 'other'}`)
      ),
    })),
    ...PASSED_FAMILIES.filter((family) => !failing.has(family)).map((family) => ({ id: `ok-${family}`, state: 'OK' as const, name: t(`family.${family}`), text: t(`passed.${family}`) })),
  ]
  return (
    <div className="fw-q-stack">
      <CheckList label={t('checks.title')} checks={lines} />
      {notes.length > 0 && (
        <>
          <h3 className="fw-lb-h3">{t('checks.notesTitle')}</h3>
          <CheckList label={t('checks.notesTitle')} checks={notes.map((row) => ({ id: row.id, state: 'UNKNOWN' as const, word: 'check.NOT_NEEDED', name: t(`family.${row.family}`), text: <CheckText family={row.family} message={row.message} /> }))} />
        </>
      )}
    </div>
  )
}

function FitLine({ label }: { label: Rendered }) {
  const t = useT('labels')
  if (!label.fit) return <p className="fw-q-hint">{t('preview.fitUnknown')}</p>
  return (
    <p className="fw-lb-fit">
      <Tag tone={label.fit.fits ? 'success' : 'danger'}>{label.fit.fits ? t('preview.fits') : t('preview.notFits')}</Tag>
      <span className="fw-q-hint">{t('preview.fit', { needed: label.fit.neededMm, available: label.fit.availableMm, chars: label.fit.charsPerLine })}</span>
    </p>
  )
}

/** Each printed value and where it came from (the API's words, as data). */
function Sources({ label }: { label: Rendered }) {
  const t = useT('labels')
  if (label.blocks.length === 0) return <EmptyState title={t('preview.noBlocks')} />
  return (
    <Disclosure className="fw-lb-sources" summary={t('preview.sources', { count: label.blocks.length })}>
      <dl className="fw-lb-sourcelist">
        {label.blocks.map((block, index) => (
          <div key={`${block.field}-${index}`} className="fw-lb-source">
            <dt>
              {t(`field.name.${block.field}`)} <Tag tone={block.placeholder ? 'neutral' : 'info'}>{t(`source.${block.source.kind}`)}</Tag>
            </dt>
            <dd>
              <span>{block.placeholder ? t('preview.atPrint') : (block.value ?? '—')}</span>
              <span className="fw-q-hint" lang="en">
                {block.source.words}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  )
}

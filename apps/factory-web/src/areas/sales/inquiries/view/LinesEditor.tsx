'use client'

import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { SizeGridEditor, SizeGridView, type SizeGridColour, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { Combobox, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { InquiryLine, StyleDetail, StyleOption } from '../api'
import { ANY_COLOUR, emptyLine, lineProblem, linePieces, sizesText, type LineDraft } from '../model'
import { useWords } from '../parts'

/** A style's detail as the container read it (its sizes and colourways). */
export type StyleRead = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: StyleDetail } | { readonly status: 'error' }

export interface LinesModel {
  readonly lines: readonly LineDraft[]
  /** The styles the picker offers (product.styles.view); null without the right. */
  readonly styles: { readonly items: readonly StyleOption[] | null; readonly problem: string | null } | null
  /** Each picked style's sizes and colourways, by id. */
  readonly details: Readonly<Record<string, StyleRead>>
}

export interface LinesActions {
  onLines?: (lines: LineDraft[]) => void
  /** A style was picked on a line: the container reads its sizes and colourways. */
  onStyle?: (styleId: string) => void
}

/** The DS size grid's words in the page's language (`sales-inquiries` `grid.*`, the stacked phone form's from `ds-words`). */
export function useGridCopy(): Partial<SizeGridCopy> {
  const { t } = useWords()
  const ds = useDsWords()
  return useMemo(
    () => ({
      ...ds.sizeGridStacked,
      caption: t('grid.caption'),
      colourHeader: t('grid.colour'),
      totalHeader: t('grid.total'),
      cellName: (colour: string, size: string) => t('grid.cellName', { colour, size }),
      notOffered: t('grid.notOffered'),
      empty: t('grid.empty'),
      totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }: { colour: string; rowTotal: string; size: string; columnTotal: string; grand: string }) => t('grid.totals', { colour, rowTotal, size, columnTotal, grand }),
      notWhole: (cell: string, max: string) => t('grid.notWhole', { cell, max }),
      cutToMax: (cell: string, max: string) => t('grid.cutToMax', { cell, max }),
      pasteResult: ({ applied, notOffered, outside, invalid, clamped }: { applied: number; notOffered: number; outside: number; invalid: number; clamped: number }) => t('grid.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
      issuesHeading: t('grid.issues'),
    }),
    [t, ds.sizeGridStacked],
  )
}

/**
 * "Styles or products asked" + "Quantities by size" (design inquiry.req.form, pop:inquiries.new): one card per line — a
 * style (in a colourway, or a colour in words) whose pieces are typed in the DS size grid over the style's own sizes, or a
 * product in words with its sizes typed as `50:5 52:10` (or pieces in all). Each line says its own problem in words
 * (model.ts lineProblem: the API's rules said first). Turning free text into lines: pick a style for what was asked.
 */
export function LinesEditor({ model, actions }: { model: LinesModel; actions?: LinesActions }) {
  const { t, say, locale } = useWords()
  const copy = useGridCopy()
  const lines = model.lines
  const set = (key: string, patch: Partial<LineDraft>) => actions?.onLines?.(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  const remove = (key: string) => actions?.onLines?.(lines.filter((line) => line.key !== key))
  const styleOptions = useMemo(() => [{ value: '', label: t('line.inWords') }, ...(model.styles?.items ?? []).map((style) => ({ value: style.id, label: `${style.code} · ${style.name}` }))], [model.styles, t])

  return (
    <div className="fw-inq-stack">
      {model.styles?.problem && <Banner tone="warning" title={t('line.stylesFailed')}>{t(model.styles.problem)}</Banner>}
      {model.styles === null && <p className="fw-inq-hint">{t('line.noStylesRight')}</p>}
      {lines.length === 0 && <p className="fw-inq-hint">{t('line.none')}</p>}
      {lines.map((line, index) => {
        const read = line.styleId ? model.details[line.styleId] : undefined
        const style = read?.status === 'ready' ? read.value : null
        const problem = lineProblem(line)
        const pieces = linePieces(line)
        const options = line.styleId && !styleOptions.some((option) => option.value === line.styleId) ? [...styleOptions, { value: line.styleId, label: line.styleLabel ?? t('line.thisStyle') }] : styleOptions
        const colourway = style?.colourways.find((one) => one.id === line.colourwayId) ?? null
        const row: SizeGridColour = { key: line.colourwayId ?? ANY_COLOUR, label: colourway ? `${colourway.code} · ${colourway.name}` : line.colourText.trim() || t('grid.anyColour'), offered: colourway && colourway.offeredSizes.length > 0 ? colourway.offeredSizes : null }
        return (
          <div className="fw-inq-line" key={line.key}>
            <div className="fw-inq-line-head">
              <h3 className="fw-inq-h3">{t('line.title', { n: index + 1 })}</h3>
              <span className="fw-inq-row">
                <span className="fw-inq-hint fw-inq-num">{t('line.pieces', { count: pieces })}</span>
                <Button size="sm" variant="quiet" aria-label={t('line.remove', { n: index + 1 })} onClick={() => remove(line.key)}>
                  <Trash2 size={14} aria-hidden /> {t('line.removeShort')}
                </Button>
              </span>
            </div>
            <div className="fw-inq-line-grid">
              <Field label={t('line.style')} hint={model.styles === null ? t('line.noStylesRight') : undefined}>
                {model.styles && model.styles.items === null && !model.styles.problem ? (
                  <Skeleton height={32} />
                ) : (
                  <Combobox
                    options={options}
                    value={line.styleId ?? ''}
                    placeholder={t('line.pickStyle')}
                    onChange={(value) => {
                      const styleId = value || null
                      const label = options.find((option) => option.value === value)?.label ?? null
                      set(line.key, { styleId, styleLabel: styleId ? label : null, colourwayId: null, sizes: {}, sizesText: styleId ? '' : sizesText(line.sizes) })
                      if (styleId) actions?.onStyle?.(styleId)
                    }}
                  />
                )}
              </Field>
              {line.styleId && (
                <Field label={t('line.colourway')}>
                  {read?.status === 'loading' ? (
                    <Skeleton height={32} />
                  ) : (
                    <Select size="sm" value={line.colourwayId ?? ''} onChange={(event) => set(line.key, { colourwayId: event.target.value || null })}>
                      <option value="">{t('line.colourInWords')}</option>
                      {(style?.colourways ?? [])
                        .filter((one) => one.status !== 'ARCHIVED' || one.id === line.colourwayId)
                        .map((one) => (
                          <option key={one.id} value={one.id}>
                            {one.code} · {one.name}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              )}
              {!line.colourwayId && (
                <Field label={t('line.colourText')} hint={t('line.colourTextHint')}>
                  <Input size="sm" value={line.colourText} maxLength={100} onChange={(event) => set(line.key, { colourText: event.target.value })} />
                </Field>
              )}
              <Field label={t('line.description')} hint={line.styleId ? t('line.descriptionStyleHint') : t('line.descriptionHint')} className="fw-inq-wide">
                <Textarea value={line.description} rows={2} honourRows maxLength={2000} onChange={(event) => set(line.key, { description: event.target.value })} />
              </Field>
              {!line.styleId && (
                <Field label={t('line.sizes')} hint={t('line.sizesHint')}>
                  <Input size="sm" value={line.sizesText} placeholder="50:5 52:10" onChange={(event) => set(line.key, { sizesText: event.target.value })} />
                </Field>
              )}
              {(!line.styleId || Object.values(line.sizes).every((pieces) => pieces === 0)) && (
                <Field label={t('line.quantity')} hint={t('line.quantityHint')}>
                  <Input size="sm" inputMode="numeric" value={line.quantity} onChange={(event) => set(line.key, { quantity: event.target.value })} />
                </Field>
              )}
              <Field label={t('line.note')}>
                <Input size="sm" value={line.note} maxLength={2000} onChange={(event) => set(line.key, { note: event.target.value })} />
              </Field>
            </div>
            {line.styleId && read?.status === 'error' && <Banner tone="warning" title={t('line.styleFailed')} />}
            {line.styleId && style && (
              <div className="fw-inq-bleed">
                <SizeGridEditor
                  colours={[row]}
                  sizes={style.sizes.map((size) => ({ key: size, label: size }))}
                  value={{ [row.key]: line.sizes }}
                  onChange={(next) => set(line.key, { sizes: Object.fromEntries(Object.entries(next[row.key] ?? {}).filter(([, pieces]) => pieces > 0)) })}
                  max={100_000}
                  layout="auto"
                  locale={INTL_LOCALE[locale]}
                  copy={copy}
                  caption={t('line.gridCaption', { n: index + 1 })}
                />
              </div>
            )}
            {line.styleId && read?.status === 'loading' && <Skeleton height={72} />}
            {problem && (
              <p className="fw-inq-hint" role="alert">
                {say(problem)}
              </p>
            )}
          </div>
        )
      })}
      <span>
        <Button size="sm" onClick={() => actions?.onLines?.([...lines, emptyLine()])}>
          <Plus size={14} aria-hidden /> {t('line.add')}
        </Button>
      </span>
    </div>
  )
}

/** The lines as asked, read only: a SummaryTable (style or words, colour, sizes, pieces, note), the sizes of a style as its grid. */
export function LinesRead({ lines }: { lines: readonly InquiryLine[] }) {
  const { t, locale } = useWords()
  const copy = useGridCopy()
  if (lines.length === 0) return <p className="fw-inq-hint">{t('line.noneAsked')}</p>
  const sorted = [...lines].sort((a, b) => a.seq - b.seq)
  return (
    <div className="fw-inq-stack">
      <SummaryTable
        label={t('line.tableLabel')}
        columns={[t('line.col.n'), t('line.col.what'), t('line.col.colour'), t('line.col.sizes'), t('line.col.pieces'), t('line.col.note')]}
        align={[undefined, undefined, undefined, undefined, 'right', 'left']}
        stackOnPhone
        rows={sorted.map((line, index) => {
          const pieces = line.quantity ?? Object.values(line.sizes).reduce((sum, n) => sum + n, 0)
          return {
            id: line.id,
            cells: [
              String(index + 1),
              line.style ? `${line.style.code} · ${line.style.name}${line.description ? ` — ${line.description}` : ''}` : (line.description ?? '—'),
              line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : (line.colourText ?? '—'),
              Object.keys(line.sizes).length > 0 ? sizesText(line.sizes) : '—',
              <span key="n" className="fw-inq-num">{pieces}</span>,
              line.note ?? '—',
            ],
          }
        })}
      />
      {sorted
        .filter((line) => line.style && Object.keys(line.sizes).length > 0)
        .map((line) => {
          const key = line.colourway?.id ?? ANY_COLOUR
          return (
            <div className="fw-inq-bleed" key={`grid-${line.id}`}>
              <SizeGridView
                colours={[{ key, label: line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : (line.colourText ?? t('grid.anyColour')) }]}
                sizes={Object.keys(line.sizes).map((size) => ({ key: size, label: size }))}
                value={{ [key]: line.sizes }}
                locale={INTL_LOCALE[locale]}
                copy={copy}
                caption={t('line.gridCaption', { n: sorted.indexOf(line) + 1 })}
                showCaption
              />
            </div>
          )
        })}
    </div>
  )
}

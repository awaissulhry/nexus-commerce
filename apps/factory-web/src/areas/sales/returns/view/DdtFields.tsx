'use client'

import { useId } from 'react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Input, Select, Spinner } from '@nexus/ui/primitives'
import { DDT_FREIGHT, DDT_TRANSPORT_BY, type DdtFreight, type DdtPreview, type DdtTransportBy } from '../api'
import { ddtPreviewWords, ddtProblems, type DdtDraft } from '../model'
import { say, useWords } from './parts'

/**
 * What a DDT of another reason asks of the office (DPR 472/1996; Shipping's source DDT, B-W2a-17): who carries the goods
 * (and the carrier's name), the packages and the gross weight, the goods' appearance, the freight and remarks; under them
 * the preview the API makes from them (the number it will take, the goods it lists, what still stops it). Used by the
 * repair's way back and by an RMA's unchanged goods going back.
 */
export function DdtFields({ draft, preview, previewing, onDraft }: { draft: DdtDraft; preview: DdtPreview | null; previewing: boolean; onDraft: (draft: DdtDraft) => void }) {
  const t = useWords()
  const ids = { by: useId(), carrier: useId(), packages: useId(), weight: useId(), appearance: useId(), freight: useId(), remarks: useId() }
  const set = (patch: Partial<DdtDraft>) => onDraft({ ...draft, ...patch })
  const problems = ddtProblems(draft)
  const shown = (key: string) => (problems.some((words) => words.key === key) ? say(t, problems.find((words) => words.key === key)) : undefined)
  return (
    <div className="fw-q-stack">
      <div className="fw-q-form-three">
        <Field label={t('ddt.transportBy')} htmlFor={ids.by}>
          <Select id={ids.by} value={draft.transportBy} onChange={(event) => set({ transportBy: event.target.value as DdtTransportBy })}>
            {DDT_TRANSPORT_BY.map((value) => (
              <option key={value} value={value}>
                {t(`ddt.by.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.transportBy === 'CARRIER' && (
          <Field label={t('ddt.carrier')} required error={draft.carrier ? undefined : shown('ddt.problem.carrier')} htmlFor={ids.carrier}>
            <Input id={ids.carrier} value={draft.carrier} onChange={(event) => set({ carrier: event.target.value })} />
          </Field>
        )}
        <Field label={t('ddt.packages')} required error={draft.packages ? shown('ddt.problem.packages') : undefined} htmlFor={ids.packages}>
          <Input id={ids.packages} inputMode="numeric" value={draft.packages} onChange={(event) => set({ packages: event.target.value })} />
        </Field>
        <Field label={t('ddt.weight')} required hint={t('ddt.weightHint')} error={draft.weight ? shown('ddt.problem.weight') : undefined} htmlFor={ids.weight}>
          <Input id={ids.weight} inputMode="decimal" value={draft.weight} onChange={(event) => set({ weight: event.target.value })} />
        </Field>
        <Field label={t('ddt.appearance')} hint={t('ddt.appearanceHint')} htmlFor={ids.appearance}>
          <Input id={ids.appearance} value={draft.appearance} onChange={(event) => set({ appearance: event.target.value })} />
        </Field>
        <Field label={t('ddt.freightLabel')} htmlFor={ids.freight}>
          <Select id={ids.freight} value={draft.freight} onChange={(event) => set({ freight: event.target.value as DdtFreight | '' })}>
            <option value="">{t('ddt.freightDefault')}</option>
            {DDT_FREIGHT.map((value) => (
              <option key={value} value={value}>
                {t(`ddt.freight.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('ddt.remarks')} htmlFor={ids.remarks}>
        <Input id={ids.remarks} value={draft.remarks} onChange={(event) => set({ remarks: event.target.value })} />
      </Field>
      {previewing && (
        <p className="fw-q-loading" role="status">
          <Spinner size={12} /> {t('ddt.previewing')}
        </p>
      )}
      {preview && (
        <div className="fw-q-stack">
          <p className="fw-q-hint">{preview.expectedNumber ? t('ddt.expected', { number: preview.expectedNumber }) : t('ddt.noNumber')}</p>
          <SummaryTable
            label={t('ddt.goods')}
            columns={[t('ddt.col.goods'), t('ddt.col.quantity')]}
            rows={preview.draft.lines.map((line) => ({ id: String(line.seq), cells: [line.description, `${line.quantity} ${line.uom}`] }))}
            stackOnPhone
          />
          {preview.problems.length > 0 && (
            <Banner tone="warning" title={t('ddt.previewProblems', { count: preview.problems.length })}>
              <ul className="fw-q-lines">
                {ddtPreviewWords(preview.problems).map((words) => (
                  <li key={words.key}>{say(t, words)}</li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      )}
    </div>
  )
}

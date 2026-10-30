'use client'

import { Field } from '@nexus/ui/components'
import { Input, Select, Textarea } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { TRANSPORT_BY, type TransportBy } from '../api'
import type { DdtDraft } from '../model'

/**
 * The return DDT's fields (B-W2a-17's source request; the same block as Send kit's, design pop:return "creates the return
 * DDT"): the reason is fixed (Reso), who carries the goods, the carrier's name when a carrier does, packages, the gross
 * weight, how the goods look, remarks. The numbering, the parties and the goods come from the claim: the DDT itself is
 * made by the server in the same act, and never changes after (a wrong one is annulled, its number kept).
 */
export function DdtFields({ draft, onChange }: { draft: DdtDraft; onChange: (next: DdtDraft) => void }) {
  const t = useT('purchasing-claims')
  const set = (next: Partial<DdtDraft>) => onChange({ ...draft, ...next })
  return (
    <div className="fw-by-stack">
      <div className="fw-by-fields">
        <Field label={t('ddt.reason')} hint={t('ddt.reasonFixed')}>
          <Input size="sm" value={t('ddt.reasonReturn')} readOnly aria-readonly="true" />
        </Field>
        <Field label={t('ddt.transportBy')} required>
          <Select size="sm" value={draft.transportBy} onChange={(event) => set({ transportBy: event.target.value as TransportBy })}>
            {TRANSPORT_BY.map((by) => (
              <option key={by} value={by}>
                {t(`ddt.by.${by}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.transportBy === 'CARRIER' && (
          <Field label={t('ddt.carrier')} required>
            <Input size="sm" maxLength={200} value={draft.carrier} onChange={(event) => set({ carrier: event.target.value })} />
          </Field>
        )}
        <Field label={t('ddt.packages')} required>
          <Input size="sm" inputMode="numeric" value={draft.packages} onChange={(event) => set({ packages: event.target.value })} />
        </Field>
        <Field label={t('ddt.weight')} required>
          <Input size="sm" inputMode="decimal" value={draft.grossWeightKg} onChange={(event) => set({ grossWeightKg: event.target.value })} suffix="kg" />
        </Field>
        <Field label={t('ddt.appearance')} hint={t('ddt.appearanceHint')}>
          <Input size="sm" maxLength={200} value={draft.appearance} onChange={(event) => set({ appearance: event.target.value })} />
        </Field>
      </div>
      <Field label={t('ddt.remarks')}>
        <Textarea rows={2} maxLength={1000} value={draft.remarks} onChange={(event) => set({ remarks: event.target.value })} />
      </Field>
      <p className="fw-by-hint">{t('ddt.fixed')}</p>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Input, Select, Skeleton } from '@nexus/ui/primitives'
import type { StyleDetail, StyleOption } from '../api'
import { useWords } from '../parts'

export interface StylePick {
  q: string
  items: StyleOption[] | null
  problem: string | null
}

/** The style a new change is for: search by code or name, then pick (product.styles.view; else held with the reason). */
export function StylePicker({ pick, style, styleId, held, onFind, onPick }: { pick: StylePick; style: StyleDetail | null; styleId: string | null; held: string | null; onFind?: (q: string) => void; onPick?: (styleId: string | null) => void }) {
  const { t } = useWords()
  const [q, setQ] = useState(pick.q)
  useEffect(() => setQ(pick.q), [pick.q])
  return (
    <Field label={t('new.style')} required hint={held ?? t('new.styleHint')}>
      <div className="fw-chg-stack">
        <Input
          size="sm"
          type="search"
          aria-label={t('new.styleSearch')}
          placeholder={t('new.styleSearch')}
          value={q}
          disabled={!!held}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onFind?.(q)
            }
          }}
          onBlur={() => q !== pick.q && onFind?.(q)}
        />
        {pick.items === null && !pick.problem && !held ? (
          <Skeleton height={32} />
        ) : (
          <Select size="sm" aria-label={t('new.style')} value={styleId ?? ''} disabled={!!held} onChange={(event) => onPick?.(event.target.value || null)}>
            <option value="">{pick.problem ? t(pick.problem) : pick.items && pick.items.length === 0 ? t('new.noStyles') : t('new.pickStyle')}</option>
            {(pick.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
            {style && !(pick.items ?? []).some((item) => item.id === style.id) && (
              <option value={style.id}>
                {style.code} · {style.name}
              </option>
            )}
          </Select>
        )}
      </div>
    </Field>
  )
}

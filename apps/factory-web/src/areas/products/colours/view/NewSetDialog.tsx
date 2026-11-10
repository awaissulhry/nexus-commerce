'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { refusedField } from '../../library/model'
import { activeIn, newSetHeldKey, suggestedCode } from '../model'
import type { ColoursActions, ColoursViewModel, NewSetModel } from '../view-model'

/**
 * New branding set (SCR-118, the band's and the section's "New branding set", the brands notice): the customer or brand it
 * is for (searched, 20 at a time), its code (suggested from the brand and the year) and name, for the company of the
 * address. A brand with a set in use in this company: the new one replaces it only when the person ticks it (the old one is
 * archived in the same command); Create is held with the reason until then.
 */
export function NewSetDialog({ form, model, actions }: { form: NewSetModel; model: ColoursViewModel; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const [search, setSearch] = useState(form.search.q)
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => actions?.onBrandSearch?.(search), 300)
    return () => clearTimeout(timer)
  }, [search])
  const draft = form.draft
  const set = (patch: Partial<NewSetModel['draft']>) => actions?.onNewSetDraft?.({ ...draft, ...patch })
  const heldKey = newSetHeldKey(draft, model.companyId)
  const held = heldKey ? t(heldKey) : form.busy ? tl('held.busy') : null
  const old = activeIn(draft.brand, model.companyId)
  const results = form.search.results
  const create = () => {
    if (!held) actions?.onCreateSet?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNewSet?.(false)}
      title={t('newSet.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNewSet?.(false)}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {form.busy ? <Spinner size={12} /> : null} {old && draft.replace ? t('newSet.replace', { code: old.code }) : t('newSet.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {form.problem && (
          <Banner tone="danger" title={tl(form.problem)}>
            {form.messages.length > 0 ? form.messages.join(' ') : null}
          </Banner>
        )}
        <p className="fw-lib-hint">{t('newSet.intro')}</p>
        <Field label={t('newSet.search')} hint={draft.brand ? t('newSet.picked', { name: draft.brand.name }) : t('newSet.searchHint')}>
          <Input
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            value={search}
            autoFocus
            onChange={(event) => {
              typed.current = true
              setSearch(event.target.value)
            }}
          />
        </Field>
        <Field label={t('newSet.brand')} error={refusedField(form.refused, 'partyId') ? t('form.refused') : undefined}>
          <Select
            value={draft.brand?.id ?? ''}
            onChange={(event) => {
              const brand = results?.find((row) => row.id === event.target.value) ?? null
              set({ brand, replace: false, ...(brand && !draft.code.trim() ? { code: suggestedCode(brand, new Date().getFullYear()) } : {}), ...(brand && !draft.name.trim() ? { name: brand.name } : {}) })
            }}
          >
            <option value="">{results === null ? t('newSet.searching') : results.length === 0 ? t('newSet.noBrands') : t('newSet.pick')}</option>
            {draft.brand && !results?.some((row) => row.id === draft.brand?.id) && <option value={draft.brand.id}>{`${draft.brand.code} · ${draft.brand.name}`}</option>}
            {(results ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {`${row.code} · ${row.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('newSet.code')} hint={t('newSet.codeHint')} error={refusedField(form.refused, 'code') ? t('form.refused') : undefined}>
          <Input value={draft.code} maxLength={60} onChange={(event) => set({ code: event.target.value })} />
        </Field>
        <Field label={t('newSet.name')} error={refusedField(form.refused, 'name') ? t('form.refused') : undefined}>
          <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        {old && (
          <Banner tone="warning" title={t('newSet.hasActive', { code: old.code, name: old.name })}>
            <Checkbox checked={draft.replace} onChange={(event) => set({ replace: event.target.checked })} label={t('newSet.replaceTick', { code: old.code })} />
          </Banner>
        )}
        <p className="fw-lib-hint">{t('newSet.after')}</p>
      </div>
    </Modal>
  )
}

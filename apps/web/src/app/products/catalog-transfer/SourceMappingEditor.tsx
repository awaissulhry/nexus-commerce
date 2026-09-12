'use client'
import { useEffect, useState } from 'react'
import { transferIsStore } from '@nexus/shared/catalog-transfer'
import { channelName } from './workbookSelection'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Disclosure, Field, Listbox } from '@/design-system/components'
import type { SourceBinding, SourceMapping, SourceReference, SourceInspection, SourcePreset, TransferOptions } from './sourceMapping'
import { transferApi } from './transferApi'
import styles from './transfer.module.css'

interface MappingField { key: string; label: string; entity: SourceBinding['entity']; kind: string; shape?: string }
export function SourceMappingEditor({ source, mapping, onChange, options, familyId, productId, disabled }: {
  source: SourceInspection; mapping: SourceMapping; onChange: (value: SourceMapping) => void; options: TransferOptions; familyId: string; productId?: string; disabled: boolean
}) {
  const [fields, setFields] = useState<MappingField[]>([]), [channelFields, setChannelFields] = useState<MappingField[]>([])
  const [account, setAccount] = useState(''), [category, setCategory] = useState(''), [error, setError] = useState('')
  const [presets, setPresets] = useState<SourcePreset[]>([]), [presetPage, setPresetPage] = useState(1), [presetTotal, setPresetTotal] = useState(0), [name, setName] = useState(''), [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const listingKey = (l: NonNullable<TransferOptions['listings']>[number]) => JSON.stringify([l.channel, l.accountId, l.marketplace, l.aliasKey])
  const destinations = [...new Map((options.listings ?? []).map(l => [listingKey(l), l])).values()]
  const destinationOptions = destinations.map(l => ({ value: listingKey(l), label: `${l.channel} ${l.marketplace} · ${options.accounts.find(a => a.id === l.accountId)?.displayName ?? l.accountId} · ${l.aliasLabel ?? (l.aliasKey || 'Primary listing')}` }))
  const [listingFields, setListingFields] = useState<Record<string, MappingField[]>>({})
  const destinationKey = destinations.map(l => l.id).join(',')
  useEffect(() => {
    if (!productId) return
    const abort = new AbortController(); setListingFields({})
    const needed = destinations.filter(l => mapping.bindings.some(b => b.entity !== 'Products' && [b.channel, b.accountId, b.marketplace, b.aliasKey].every((r, i) => (!r ? '' : 'value' in r ? r.value : null) === [l.channel, l.accountId, l.marketplace, l.aliasKey][i])))
    void Promise.all(needed.map(async l => [listingKey(l), (await transferApi<{ fields: MappingField[] }>(`catalog-transfer/source/fields?market=${mapping.market}&productId=${encodeURIComponent(productId)}&listingId=${encodeURIComponent(l.id)}`, undefined, abort.signal)).fields] as const)).then(entries => { if (!abort.signal.aborted) setListingFields(Object.fromEntries(entries)) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [productId, destinationKey, mapping.market, JSON.stringify(mapping.bindings.map(b => [b.channel, b.accountId, b.marketplace, b.aliasKey]))])
  const selectedAccount = options.accounts.find(a => a.id === account)
  const store = transferIsStore(selectedAccount?.channelType ?? '')
  const dictionaryMarket = store ? 'GLOBAL' : mapping.market
  const headerOptions = source.headers.map(h => ({ value: h, label: h }))
  useEffect(() => {
    const abort = new AbortController(); setFields([])
    void transferApi<{ fields: MappingField[] }>(`catalog-transfer/source/fields?market=${mapping.market}&familyId=${encodeURIComponent(familyId)}`, undefined, abort.signal).then(r => { if (!abort.signal.aborted) setFields(r.fields) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [mapping.market, familyId])
  useEffect(() => {
    const abort = new AbortController(); setChannelFields([])
    if (selectedAccount && (store || category.trim())) void transferApi<{ fields: MappingField[] }>(`catalog-transfer/source/fields?market=${mapping.market}&marketplace=${dictionaryMarket}&channel=${selectedAccount.channelType}&category=${encodeURIComponent(category.trim())}`, undefined, abort.signal).then(r => { if (!abort.signal.aborted) setChannelFields(r.fields) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [selectedAccount, category, mapping.market, store, dictionaryMarket])
  useEffect(() => {
    const abort = new AbortController()
    void transferApi<{ presets: SourcePreset[]; total: number }>(`catalog-transfer/source/presets?page=${presetPage}`, undefined, abort.signal).then(r => { if (!abort.signal.aborted) { setPresets(r.presets); setPresetTotal(r.total) } }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [presetPage, saved])
  const update = (index: number, value: Partial<SourceBinding>) => onChange({ ...mapping, bindings: mapping.bindings.map((b, i) => i === index ? { ...b, ...value } : b) })
  const save = async () => {
    setSaving(true); setError('')
    try { const result = await transferApi<SourcePreset>('catalog-transfer/source/presets', { name, mapping }); setSaved(`Saved “${result.name}” · ${result.id}`); setName('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) }
  }
  return <div className={styles.stack}>
    <p><strong>{source.filename}</strong> · {source.total.toLocaleString()} source records · {source.headers.length} columns</p>
    {error && <Banner tone="danger" onDismiss={() => setError('')}>{error}</Banner>}
    {saved && <Banner tone="success">{saved}</Banner>}
    <div className={styles.fields}>
      <Field label="Saved incoming mapping"><Listbox value="" options={presets.map(p => ({ value: p.id, label: p.name }))} disabled={disabled} emptyLabel="Choose a saved mapping" onChange={id => { const p = presets.find(p => p.id === id); if (p) { onChange({ ...p.columnMapping, market: mapping.market, mode: mapping.mode }); setSaved(`Loaded “${p.name}”; this review uses a copy of its mapping and policy.`) } }} width="100%" /></Field>
      <Field label="SKU column" hint="Matches the existing product or variant exactly, including leading zeros."><Listbox options={headerOptions} value={mapping.skuColumn} onChange={skuColumn => onChange({ ...mapping, skuColumn })} disabled={disabled} width="100%" /></Field>
    </div>
    {presetTotal > 50 && <div className={styles.actions}><Button disabled={presetPage <= 1} onClick={() => setPresetPage(p => p - 1)}>Previous mappings</Button><span>Page {presetPage} of {Math.ceil(presetTotal / 50)}</span><Button disabled={presetPage * 50 >= presetTotal} onClick={() => setPresetPage(p => p + 1)}>More mappings</Button></div>}
    <div className={styles.fields}>
      <Field label="Shared data ownership"><Listbox value={mapping.policy.shared} options={[{ value: 'replace', label: 'Update mapped shared facts' }, { value: 'fill-empty', label: 'Only fill missing shared facts' }, { value: 'exclude', label: 'Exclude shared updates' }]} onChange={v => onChange({ ...mapping, policy: { ...mapping.policy, shared: v as SourceMapping['policy']['shared'] } })} disabled={disabled} width="100%" /></Field>
      <Field label="Listing override ownership"><Listbox value={mapping.policy.overrides} options={[{ value: 'preserve', label: 'Preserve existing overrides' }, { value: 'replace', label: 'Update mapped overrides' }, { value: 'exclude', label: 'Exclude listing changes' }]} onChange={v => onChange({ ...mapping, policy: { ...mapping.policy, overrides: v as SourceMapping['policy']['overrides'] } })} disabled={disabled} width="100%" /></Field>
    </div>
    {!productId && <Disclosure summary="Choose the channel field dictionary">
      <div className={styles.fields}>
        <Field label="Dictionary account"><Listbox options={options.accounts.map(a => ({ value: a.id, label: `${a.channelType} · ${a.displayName ?? a.id}` }))} value={account} onChange={v => { setAccount(v); setCategory('') }} disabled={disabled} emptyLabel="Shared fields" width="100%" /></Field>
        {account && <Field label={selectedAccount?.channelType === 'AMAZON' ? 'Amazon product type' : `${channelName(selectedAccount?.channelType ?? '')} category ID`} hint={store ? 'Optional. Core product fields are available for mapping.' : "Loads the category's canonical attributes for mapping."}><Input value={category} onChange={e => setCategory(e.target.value)} disabled={disabled} /></Field>}
      </div>
    </Disclosure>}
    {mapping.bindings.map((b, index) => {
      const bindingKey = JSON.stringify([b.channel, b.accountId, b.marketplace, b.aliasKey].map(r => !r ? '' : 'value' in r ? r.value : null))
      const catalogue = b.entity === 'Products' ? fields.filter(f => !productId || f.key !== 'parentSku') : productId ? listingFields[bindingKey] ?? [] : channelFields
      const fieldOptions = catalogue.map(f => ({ value: `${f.entity}:${f.key}`, label: `${f.label} · ${f.key}` }))
      if (b.field && !fieldOptions.some(f => f.value === `${b.entity}:${b.field}`)) fieldOptions.unshift({ value: `${b.entity}:${b.field}`, label: `${b.field} · validated at preview` })
      return <div className={styles.mappingRow} key={index}>
        <div className={styles.actions}><strong>Mapping {index + 1}</strong><Button size="sm" variant="quiet" disabled={disabled} onClick={() => onChange({ ...mapping, bindings: mapping.bindings.filter((_, i) => i !== index) })}>Remove mapping {index + 1}</Button></div>
        <div className={styles.fields}>
          <Field label={`Source column ${index + 1}`} hint={source.sample[0]?.[b.source] ? `First record: ${source.sample[0][b.source].slice(0, 120)}` : 'Blank and omitted source values are preserved.'}><Listbox options={headerOptions} value={b.source} onChange={source => update(index, { source })} disabled={disabled} width="100%" /></Field>
          <Field label={`Destination ${index + 1}`}><Listbox options={[{ value: 'Products', label: 'Shared product / variant' }, ...(productId ? destinationOptions : options.accounts.map(a => ({ value: a.id, label: `${a.channelType} · ${a.displayName ?? a.id}` })))]} value={b.entity === 'Products' ? 'Products' : productId ? bindingKey : b.accountId && 'value' in b.accountId ? b.accountId.value : account} onChange={v => {
            const a = options.accounts.find(a => a.id === v)
            const l = destinations.find(l => listingKey(l) === v)
            update(index, v === 'Products' ? { entity: 'Products', field: '', channel: undefined, accountId: undefined, marketplace: undefined, aliasKey: undefined } : { entity: 'Overrides', field: '', channel: { value: l?.channel ?? a?.channelType ?? '' }, accountId: { value: l?.accountId ?? v }, marketplace: { value: l?.marketplace ?? (transferIsStore(a?.channelType ?? '') ? 'GLOBAL' : mapping.market) }, aliasKey: { value: l?.aliasKey ?? '' } })
          }} disabled={disabled} searchable width="100%" /></Field>
          <Field label={`Destination field ${index + 1}`}><Listbox options={fieldOptions} value={`${b.entity}:${b.field}`} onChange={v => { const f = catalogue.find(f => `${f.entity}:${f.key}` === v); if (f) update(index, { entity: f.entity, field: f.key, format: f.shape && f.shape !== 'scalar' || ['number', 'boolean'].includes(f.kind) ? 'json' : 'text' }) }} disabled={disabled} searchable width="100%" /></Field>
          <Field label={`Value format ${index + 1}`}><Listbox options={[{ value: 'text', label: 'Text (keeps leading zeros)' }, { value: 'json', label: 'JSON (numbers, lists, records)' }]} value={b.format} onChange={format => update(index, { format: format as SourceBinding['format'] })} disabled={disabled} width="100%" /></Field>
        </div>
        <Disclosure summary={`Actions, versions and exact coordinates for mapping ${index + 1}`}>
          <div className={styles.fields}>
            <Field label={`Action ${index + 1}`} hint="SET uses a populated value. CLEAR and INHERIT require an empty value cell."><Listbox options={['SET', 'CLEAR', 'INHERIT'].map(value => ({ value, label: value }))} value={b.action ?? 'SET'} onChange={action => update(index, { action: action as SourceBinding['action'] })} disabled={disabled} width="100%" /></Field>
            <Field label={`Action column ${index + 1}`}><Listbox options={headerOptions} value={b.actionColumn ?? ''} emptyLabel="Use selected action" onChange={actionColumn => update(index, { actionColumn: actionColumn || undefined })} disabled={disabled} width="100%" /></Field>
            <Field label={`Record version column ${index + 1}`} hint="Shared and listing versions are different. Preview always freezes the current record."><Listbox options={headerOptions} value={b.versionColumn ?? ''} emptyLabel="Use current preview version" onChange={versionColumn => update(index, { versionColumn: versionColumn || undefined })} disabled={disabled} width="100%" /></Field>
            {(b.entity === 'Products' ? ['locale'] as const : ['channel', 'accountId', 'marketplace', 'aliasKey'] as const).map(k => <ReferenceField key={k} label={`${k} ${index + 1}`} value={b[k]} headers={source.headers} onChange={value => update(index, { [k]: value })} disabled={disabled} />)}
          </div>
        </Disclosure>
      </div>
    })}
    <div><Button disabled={disabled || mapping.bindings.length >= 200} onClick={() => onChange({ ...mapping, bindings: [...mapping.bindings, { source: source.headers.find(h => h !== mapping.skuColumn) ?? source.headers[0], entity: 'Products', field: '', format: 'text' }] })}>Add column mapping</Button></div>
    <div className={styles.fields}>
      <Field label="Save this incoming mapping" hint="Stores column destinations and ownership choices for another file."><Input value={name} onChange={e => setName(e.target.value)} maxLength={120} disabled={disabled || saving} placeholder="Supplier catalog" /></Field>
      <div className={styles.actions}><Button disabled={disabled || saving || !name.trim() || !mapping.bindings.length} onClick={save}>Save mapping</Button></div>
    </div>
    <p className={styles.secondary}>Unmapped columns are excluded. Shared updates preserve listing overrides. Pricing, stock and publication remain in their dedicated workspaces.</p>
  </div>
}

function ReferenceField({ label, value, headers, onChange, disabled }: { label: string; value?: SourceReference; headers: string[]; onChange: (v: SourceReference) => void; disabled: boolean }) {
  return <div className={styles.stack}>
    <Field label={label}><Listbox value={value && 'column' in value ? value.column : ''} emptyLabel="Fixed value" options={headers.map(h => ({ value: h, label: `From column: ${h}` }))} onChange={v => onChange(v ? { column: v } : { value: '' })} disabled={disabled} width="100%" /></Field>
    {(!value || 'value' in value) && <Field label={`Fixed ${label}`}><Input value={value?.value ?? ''} onChange={e => onChange({ value: e.target.value })} disabled={disabled} /></Field>}
  </div>
}

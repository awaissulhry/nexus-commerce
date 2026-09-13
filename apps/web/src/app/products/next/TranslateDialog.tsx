'use client'
import { useEffect, useRef, useState } from 'react'
import type { CatalogTranslateInput, CatalogTranslatePreview, CatalogTranslationRun, CatalogTranslateScope } from '@nexus/shared/products-grid'
import { Button } from '@/design-system/primitives'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { transferApi } from '../catalog-transfer/transferApi'
import styles from './language.module.css'

export const languageLabel = (language: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language
export function useCatalogLanguages() {
  const [data, setData] = useState<{ sourceLanguage: string; languages: string[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void transferApi<{ sourceLanguage: string; languages: string[] }>('catalog-transfer/languages', undefined, controller.signal)
      .then(setData).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [])
  return { ...data, error, options: (data?.languages ?? []).map(language => ({ value: language, label: `${languageLabel(language)}${language === data?.sourceLanguage ? ' · source' : ''}` })) }
}

export function TranslateDialog({ open, onClose, language, scope }: { open: boolean; onClose: () => void; language: string; scope: CatalogTranslateScope }) {
  const [field, setField] = useState('title'), [preview, setPreview] = useState<CatalogTranslatePreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sequence = useRef(0)
  const [runs, setRuns] = useState<CatalogTranslationRun[]>([])
  const loadRuns = () => transferApi<CatalogTranslationRun[]>(`catalog-transfer/translate/runs?language=${encodeURIComponent(language)}`).then(setRuns)
  useEffect(() => { if (open && language) void loadRuns().catch(e => setError(e.message)) }, [open, language])
  const scopeKey = JSON.stringify(scope)
  useEffect(() => { sequence.current++; setPreview(null); setError(''); setBusy(false) }, [open, language, field, scopeKey])
  async function estimate() {
    const request = ++sequence.current
    setBusy(true); setError(''); setPreview(null)
    try {
      const input: CatalogTranslateInput = { scope, language, fields: field === 'all' ? ['title', 'description', 'bulletPoints', 'keywords'] : [field] }
      const next = await transferApi<CatalogTranslatePreview>('catalog-transfer/translate/preview', input)
      if (sequence.current === request) setPreview(next)
    } catch (error) { if (sequence.current === request) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (sequence.current === request) setBusy(false) }
  }
  async function revert(id: string) {
    setBusy(true); setError('')
    try {
      const result = await transferApi<{ status: string }>(`catalog-transfer/translate/${encodeURIComponent(id)}/revert`, {})
      await loadRuns()
      if (result.status === 'REVERT_PARTIAL') setError('Some products changed after this run and were preserved. Revert completed for the other products.')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <Modal open={open} onClose={onClose} title={`Translate · ${language ? languageLabel(language) : 'Choose a language'}`} size="lg"
    subtitle="Every product matching the page filter, across all pages."
    footer={<><Button onClick={onClose}>Close</Button><Button onClick={() => void estimate()} disabled={busy || !language}>{busy ? 'Estimating…' : 'Preview translation'}</Button><Button variant="primary" disabled title={preview?.gate ?? 'Preview first; AI generation is currently disabled.'}>Generate drafts</Button></>}>
    <div className={styles.stack}>
      <Field label="Fields"><Listbox value={field} onChange={setField} options={[{ value: 'title', label: 'Title' }, { value: 'description', label: 'Description' }, { value: 'bulletPoints', label: 'Bullet points' }, { value: 'keywords', label: 'Keywords' }, { value: 'all', label: 'All descriptive content' }]} /></Field>
      {error && <Banner tone="danger">{error}</Banner>}
      {preview && <>
        <div className={styles.counts} aria-label="Translation preview counts">
          <span><strong>{preview.getDraft.toLocaleString()}</strong> get a draft</span>
          <span><strong>{preview.alreadyHave.toLocaleString()}</strong> already have</span>
          <span><strong>{preview.skipped.toLocaleString()}</strong> skipped</span>
        </div>
        <p>{preview.reach}</p><p>{preview.destinations.join(' · ') || 'No active destination in this language.'}</p>
        <div><strong>Estimated cost · USD</strong>{preview.estimates.map(estimate => <p key={estimate.provider}>{estimate.model}: ${estimate.usd.toFixed(4)}</p>)}<p>Estimates use the current Nexus rate cards and estimated token counts. No model has been selected.</p></div>
        <Banner tone="info">{preview.gate} A completed run can be reverted as one operation. Drafts require review before publishing.</Banner>
      </>}
      {runs.length > 0 && <div className={styles.stack}><strong>Recent {languageLabel(language)} runs</strong>{runs.map(run => <div key={run.id}>{run.productCount.toLocaleString()} {run.productCount === 1 ? 'product' : 'products'} · {run.status.toLowerCase().replace(/_/g, ' ')} · {new Date(run.createdAt).toLocaleString()}{['COMPLETED', 'PARTIAL', 'REVERT_PARTIAL'].includes(run.status) && <Button size="sm" disabled={busy} onClick={() => void revert(run.id)}>Revert run</Button>}</div>)}</div>}
    </div>
  </Modal>
}

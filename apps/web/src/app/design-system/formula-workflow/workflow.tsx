'use client'
import { useEffect, useState } from 'react'
import { measureFormulaDialog } from './measure'
import { Button } from '@/design-system/primitives'
import { FormulaBulkDialog } from '@/app/products/[id]/edit/_studio/sheet/FormulaBulkDialog'
import { FormulaHistoryDialog } from '@/app/products/[id]/edit/_studio/sheet/FormulaHistoryDialog'
import { formulaOperationRequest } from '@/app/products/[id]/edit/_studio/sheet/formulaOperations'
const coordinate = { scope: 'master' as const, market: 'IT', locale: 'it' }
const columns = ['manufacturer', 'brand', 'name', 'basePrice'].map(key => ({ key, label: { manufacturer: 'Manufacturer', brand: 'Brand', name: 'Title', basePrice: 'Price' }[key]!, kind: key === 'basePrice' ? 'number' : 'text', editable: true }))
const candidates = columns.map(column => ({ kind: 'field' as const, name: column.key, label: column.label }))
export function FormulaWorkflowFixture() {
  const [dialog, setDialog] = useState<'apply' | 'history' | null>(null)
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const theme = query.get('theme')
    const timer = setTimeout(() => {
      if (theme) document.documentElement.classList.toggle('dark', theme === 'dark')
      if (query.get('dialog') === 'apply') setDialog('apply')
    }, 100)
    const enforce = () => { if (theme && document.documentElement.classList.contains('dark') !== (theme === 'dark')) document.documentElement.classList.toggle('dark', theme === 'dark') }
    const observer = new MutationObserver(enforce)
    if (theme) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [])
  useEffect(() => {
    if (window.parent === window) return
    let timer: ReturnType<typeof setTimeout>
    const publish = () => { clearTimeout(timer); timer = setTimeout(() => window.parent.postMessage({ kind: 'formula-measurement', result: measureFormulaDialog() }, window.location.origin), 250) }
    const observer = new MutationObserver(publish)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    publish()
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [])
  const [updates, setUpdates] = useState(0)
  return <section aria-label="Formula verification" style={{ padding: 'var(--nds-space-16)' }}>
    <h1>Formula workflow · disposable sample</h1>
    <p>This local fixture uses an isolated database. All product writes and operation recovery use the real API.</p>
    <Button onClick={() => setDialog('apply')}>Apply sample formula</Button>{' '}
    <Button onClick={() => setDialog('history')}>Formula history</Button>
    <p role="status">Completed interactions: {updates}</p>
    {dialog === 'apply' && <FormulaBulkDialog rows={[{ id: 'one', label: 'Sample jacket' }]} columns={columns} coordinate={coordinate}
      candidatesFor={() => candidates} functions={[]} preview={async (productId, fieldKey, expr, signal) => {
        const response = await formulaOperationRequest<{ rows: any[] }>('preview', { ...coordinate, fieldKey, expr, mode: 'linked', rows: [{ productId }] }, 'POST', signal)
        return response.rows[0]
      }} onClose={() => setDialog(null)} onApplied={() => setUpdates(value => value + 1)} />}
    {dialog === 'history' && <FormulaHistoryDialog familyProductId="one" coordinate={coordinate} onClose={() => setDialog(null)} onApplied={() => setUpdates(value => value + 1)} />}
  </section>
}

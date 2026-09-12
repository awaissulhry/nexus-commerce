'use client'
import { useState } from 'react'
import { Field } from '@/design-system/components'
import { Select, Textarea } from '@/design-system/primitives'
import { editTags } from './informationEditing'
import styles from './information.module.css'

export function InformationTagsEditor({ original, disabled, onChange }: { original: string | null; disabled: boolean; onChange(value: string): void }) {
  const [operation, setOperation] = useState<'replace' | 'add' | 'remove'>('replace')
  const [text, setText] = useState(() => { try { return JSON.parse(original ?? '[]').join('\n') } catch { return original ?? '' } })
  const [error, setError] = useState('')
  function change(value: string, mode: typeof operation) {
    setText(value); setOperation(mode)
    try { onChange(editTags(original, value, mode)); setError('') } catch (e) { setError((e as Error).message) }
  }
  return <div className={styles.stack}>
    <Field label="Tag operation"><Select size="sm" disabled={disabled} value={operation} onChange={e => change('', e.target.value as typeof operation)}>
      <option value="replace">Replace all tags</option><option value="add">Add tags</option><option value="remove">Remove tags</option>
    </Select></Field>
    <Field label={operation === 'replace' ? 'Tags' : operation === 'add' ? 'Tags to add' : 'Tags to remove'} hint={operation === 'replace' ? 'One tag per line. An empty list removes all tags from this product.' : 'One tag per line. Other tags stay as they are.'}>
      <Textarea rows={6} disabled={disabled} value={text} onChange={e => change(e.target.value, operation)} />
    </Field>
    {error && <p role="alert">{error}</p>}
  </div>
}

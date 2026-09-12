'use client'
import { useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Field, KeyValue, Listbox, Modal } from '@/design-system/components'
import { categoryCommand, type CategoryCommand, type CategoryRow, type ChangeImpact, type Directory } from './api'
import styles from './categories.module.css'

export function CategoryDialog({ action, category, parentId, directory, onClose, onSaved }: {
  action: CategoryCommand['action']; category?: CategoryRow; parentId?: string; directory: Directory; onClose: () => void; onSaved: (directory: Directory) => void;
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [slug, setSlug] = useState(category?.slug ?? '')
  const [slugEdited, setSlugEdited] = useState(!!category)
  const [code, setCode] = useState(category?.code ?? '')
  const [parent, setParent] = useState(parentId ?? category?.parentId ?? '')
  const [review, setReview] = useState<ChangeImpact | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const [expectedToken] = useState(directory.token)
  const isForm = action === 'create' || action === 'rename'
  const dirty = name !== (category?.name ?? '') || slug !== (category?.slug ?? '') || code !== (category?.code ?? '') || parent !== (parentId ?? category?.parentId ?? '')
  const command: CategoryCommand = { action, id: category?.id, name: name.trim(), slug, code, parentId: parent || null, expectedToken }
  const save = async () => {
    setBusy(true); setError(null)
    try {
      if (!review) setReview(await categoryCommand<ChangeImpact>('preview', command))
      else { const result = await categoryCommand<{ directory: Directory }>('apply', command); onSaved(result.directory) }
    } catch (error) { setError(error instanceof Error ? error.message : 'Category change failed.') }
    finally { setBusy(false) }
  }
  const descendants = new Set(category ? [category.id] : [])
  for (const row of directory.rows) if (row.parentId && descendants.has(row.parentId)) descendants.add(row.id)
  const close = () => { if (!busy) dirty ? setDiscard(true) : onClose() }
  const title = { create: 'New category', rename: 'Edit category', move: 'Move category', delete: 'Delete category' }[action]
  return <Modal open title={title} subtitle={category?.path ?? 'Organize your products with a shared category.'} size="md" onClose={close} footer={<>
    <Button size="sm" disabled={busy} onClick={close}>Cancel</Button>
    {review && <Button size="sm" disabled={busy} onClick={() => setReview(null)}>Back</Button>}
    <Button size="sm" variant={action === 'delete' && review ? 'danger' : 'primary'} disabled={busy || discard || !!review?.blocked || (isForm && (!name.trim() || !slug))} onClick={() => void save()}>{busy ? 'Working…' : review ? action === 'delete' ? 'Delete empty category' : 'Save category' : 'Review change'}</Button>
  </>}>
    <div className={styles.stack}>
      {error && <Banner tone="danger">{error}</Banner>}
      {discard ? <Banner tone="warning" title="Discard your changes?" action={<><Button size="sm" onClick={() => setDiscard(false)}>Keep editing</Button><Button size="sm" variant="danger-outline" onClick={onClose}>Discard</Button></>}>Your category changes have not been saved.</Banner> : null}
      {review ? <>
        <KeyValue columns={2} items={[{ label: 'Category', value: isForm ? name : category?.name }, { label: 'Products in this subtree', value: review.productCount }, { label: 'Child categories in this subtree', value: review.descendantCount }, { label: 'Parent after change', value: action === 'rename' || action === 'delete' ? 'Unchanged' : directory.rows.find(c => c.id === parent)?.path ?? 'Top level' }]} />
        {review.blocked ? <Banner tone="warning" title="Resolve this before continuing">{review.blocked}{review.inheritedChanges.length > 0 && <p>{review.inheritedChanges.join(' · ')}</p>}</Banner>
          : <Banner tone="info">{action === 'delete' ? 'This empty category will be removed.' : 'This changes your internal category organization.'} Channel listings will not be published.</Banner>}
      </> : <>
        {isForm && <>
          <Field label="Category name" required><Input autoFocus required maxLength={160} value={name} onChange={event => { const value = event.target.value; setName(value); if (!slugEdited) setSlug(value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100)) }} /></Field>
          <Field label="Reference code" hint="Optional code used by your team or imports."><Input maxLength={100} value={code} onChange={event => setCode(event.target.value)} /></Field>
          <Field label="URL key" required hint="Unique within its parent. Changing a name does not change the category’s ID."><Input maxLength={100} value={slug} onChange={event => { setSlugEdited(true); setSlug(event.target.value) }} /></Field>
        </>}
        {(action === 'create' || action === 'move') && <Field label="Parent category"><Listbox searchable width="100%" value={parent} onChange={setParent} options={[{ value: '', label: 'Top level' }, ...directory.rows.filter(c => c.active && !descendants.has(c.id)).map(c => ({ value: c.id, label: c.path }))]} /></Field>}
        {action === 'move' && <Banner tone="info">Child categories move together. The review checks affected products and inherited channel assignments.</Banner>}
        {action === 'delete' && <Banner tone="warning">Only an empty category without child categories or channel assignments can be deleted. The next step checks its current usage.</Banner>}
      </>}
    </div>
  </Modal>
}

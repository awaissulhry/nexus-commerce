'use client'

import { useEffect, useState } from 'react'

import { Banner, Field, MediaPreview, Modal } from '@/design-system/components'
import { Button, Radio, SegmentedControl, Select } from '@/design-system/primitives'

import { defaultKeep, guessLanguage, languageName, photoPlacements, photoSource, sharedPlacements, versionLanguages, type LibraryAsset, type MediaRead } from './model'
import styles from './planPage.module.css'

export type LookalikeMode = 'same' | 'versions'

export interface SamePhotoDialogProps {
  read: MediaRead
  /** The two cards that look alike and what they most likely are, or null when closed. */
  pair: { a: string; b: string; kind?: LookalikeMode } | null
  onClose(): void
  /** Keep `keep`; `drop` becomes its copy. Resolves with the server's answer, rejects with its sentence. */
  onSame(keep: LibraryAsset, drop: LibraryAsset): Promise<void>
  /** Both are language versions of one photo, each in its language. */
  onVersions(a: LibraryAsset, b: LibraryAsset, languages: Record<string, string>): Promise<void>
  onDistinct(a: LibraryAsset, b: LibraryAsset): Promise<void>
}

/**
 * Images rebuild W4a/W4b — two library photos that look alike, side by side with their source, size and where each one
 * is used (LIBRARY-DUPLICATES.md Fix 2). They are either **the same photo** at two addresses (keep one; the other
 * becomes its copy in every photo set) or **language versions of one photo** (each in its language; every market shows
 * its own version, and a set that showed both keeps one). "Not the same" stops the suggestion. Nothing is deleted and
 * nothing is sent to a channel.
 */
export function SamePhotoDialog({ read, pair, onClose, onSame, onVersions, onDistinct }: SamePhotoDialogProps) {
  const a = pair ? read.library.find(x => x.id === pair.a) ?? null : null
  const b = pair ? read.library.find(x => x.id === pair.b) ?? null : null
  const [mode, setMode] = useState<LookalikeMode>('same')
  const [keepId, setKeepId] = useState<string | null>(null)
  const [languages, setLanguages] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'same' | 'versions' | 'distinct' | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!a || !b) return
    setMode(pair?.kind ?? 'same'); setKeepId(defaultKeep(read, a, b).id)
    setLanguages({ [a.id]: guessLanguage(a), [b.id]: guessLanguage(b) }); setError('')
  }, [pair?.a, pair?.b, pair?.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!pair || !a || !b) return <Modal open={false} onClose={onClose} title="Same photo?" />
  const keep = keepId === b.id ? b : a, drop = keep === a ? b : a
  const options = versionLanguages(read)
  const tagA = languages[a.id] ?? '', tagB = languages[b.id] ?? ''
  const versionsProblem = !tagA || !tagB ? 'Choose the language of each photo.' : tagA === tagB ? 'Two versions of one photo need two different languages.' : ''
  const run = async (kind: 'same' | 'versions' | 'distinct') => {
    setBusy(kind); setError('')
    try {
      if (kind === 'same') await onSame(keep, drop)
      else if (kind === 'versions') await onVersions(a, b, { [a.id]: tagA, [b.id]: tagB })
      else await onDistinct(a, b)
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const side = (x: LibraryAsset) => {
    const where = photoPlacements(read, [x.id, ...(x.copies ?? [])])
    return <section className={styles.sameSide} aria-label={x.label}>
      <MediaPreview type={x.mediaType} url={x.url} label={x.label} />
      {mode === 'same'
        ? <Radio name="same-photo-keep" label={`Keep ${x.label}`} checked={keep.id === x.id} disabled={!!busy} onChange={() => setKeepId(x.id)} />
        : <Field label={`Language of ${x.label}`}>
          <Select size="sm" value={languages[x.id] ?? ''} disabled={!!busy} onChange={e => setLanguages(current => ({ ...current, [x.id]: e.target.value }))}>
            <option value="">Choose a language</option>
            {options.map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
            <option value="mul">Several languages</option>
          </Select>
        </Field>}
      <p className={styles.muted}>{photoSource(x.url)}{x.width && x.height ? ` · ${x.width} × ${x.height} px` : ''}{x.copies?.length ? ` · stored ${x.copies.length + 1} times` : ''}</p>
      <p className={styles.muted}>{where.length ? `Used in: ${where.join('; ')}` : 'Not in any photo set'}</p>
    </section>
  }
  const moves = photoPlacements(read, [drop.id, ...(drop.copies ?? [])])
  const both = sharedPlacements(read, a, b)
  const main = read.mainLanguage
  const kept = tagA === main ? a : tagB === main ? b : null
  const summary = mode === 'same'
    ? (moves.length ? `${drop.label} becomes a copy of ${keep.label}. These photo sets show ${keep.label} instead: ${moves.join('; ')}.`
      : `${drop.label} becomes a copy of ${keep.label}. No photo set uses it, so no set changes.`)
    : `Each market shows its own version.${both.length ? ` These sets show both today and will keep ${kept ? `${kept.label} (${languageName(main)}, the main language)` : 'the first of them'}: ${both.join('; ')}.` : ''}`

  return <Modal open onClose={() => { if (!busy) onClose() }} size="lg" title="Same photo, or language versions?"
    subtitle="These two photos look alike. Nothing is deleted and nothing is sent to a channel."
    footer={<>
      <Button size="sm" disabled={!!busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('distinct')}>{busy === 'distinct' ? 'Saving…' : 'Not the same'}</Button>
      {mode === 'same'
        ? <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void run('same')}>{busy === 'same' ? 'Saving…' : `Same photo — keep ${keep.label}`}</Button>
        : <Button size="sm" variant="primary" disabled={!!busy || !!versionsProblem} onClick={() => void run('versions')}>{busy === 'versions' ? 'Saving…' : 'Make them language versions'}</Button>}
    </>}>
    <div className={styles.sameBody}>
      <SegmentedControl ariaLabel="These two photos are" size="sm" wrap value={mode} disabled={!!busy} onChange={value => { setMode(value as LookalikeMode); setError('') }}
        options={[{ value: 'same', label: 'The same photo' }, { value: 'versions', label: 'Language versions of one photo' }]} />
      <div className={styles.samePair}>{side(a)}{side(b)}</div>
      <p className={styles.sameText}>{summary}</p>
      {mode === 'versions' && versionsProblem && <p className={styles.muted} role="status">{versionsProblem}</p>}
      {error && <Banner tone="danger" title="Nothing was changed">{error}</Banner>}
    </div>
  </Modal>
}

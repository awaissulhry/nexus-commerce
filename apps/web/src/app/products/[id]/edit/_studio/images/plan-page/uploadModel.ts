import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'
import { parseMediaFileName, versionGroups, type FileNameContext, type ParsedFileName } from '@nexus/shared/media-plan-files'

import { cardOf, setRows, valueLabel, viewAxis, viewStack, type LayerView, type MediaRead } from './model'

/**
 * Images rebuild P4b — the upload dialog's logic (PLAN.md §4.6, §5.5), pure so it is tested without a browser.
 *
 * Each dropped file becomes a row: the set, position and language read from its name (every guess can be changed), and
 * what the library's duplicate check said once it was uploaded. "Place" turns the rows into plan edits: each set gets
 * its photos at their positions; files that differ only by language are versions of one photo, placed once.
 */

export type UploadStatus =
  | { kind: 'waiting' }
  | { kind: 'uploading' }
  /** A new photo in the library. */
  | { kind: 'new'; assetId: string }
  /** The same bytes are already in the library: that photo is used. */
  | { kind: 'exact'; assetId: string }
  /** It looks like a library photo: use that one (default) or upload this file anyway. */
  | { kind: 'similar'; candidate: { id: string; url: string; label: string } }
  | { kind: 'failed'; message: string }

export interface UploadRow {
  key: string
  fileName: string
  preview: string | null
  set: MediaSetRef
  /** 1-based; null = the end of the set. */
  position: number | null
  language: string
  swatch: boolean
  base: string
  reason: string
  status: UploadStatus
  /** For a "looks like" file: place the library photo (`use`) or upload this file anyway (`upload`). */
  choice: 'use' | 'upload'
}

/** The names each value of the picture axis goes by: its label and its dictionary code (`color:black` → "black"). */
export function fileNameContext(read: MediaRead): FileNameContext {
  const { axis } = viewAxis(read, viewStack(read, { layer: 'SHARED' }))
  const info = read.family.axes.find(a => a.code === axis)
  return {
    values: (info?.values ?? []).map(v => {
      const code = v.key.slice(v.key.indexOf(':') + 1).replace(/^text:/, '')
      return { key: v.key, label: valueLabel(read, v.key), names: [...new Set([code, v.label].filter(Boolean))] }
    }),
    skus: read.family.variants.map(v => ({ productId: v.productId, sku: v.sku })),
  }
}

export function rowFromFile(key: string, fileName: string, preview: string | null, context: FileNameContext): UploadRow {
  const parsed: ParsedFileName = parseMediaFileName(fileName, context)
  return { key, fileName, preview, ...parsed, status: { kind: 'waiting' }, choice: 'use' }
}

/** The library photo a row places, once its upload answered; null while waiting or when it failed. */
export function placedAsset(row: UploadRow): string | null {
  const s = row.status
  if (s.kind === 'new' || s.kind === 'exact') return s.assetId
  if (s.kind === 'similar' && row.choice === 'use') return s.candidate.id
  return null
}

/** Rows that are language versions of one photo (same set and name apart from the language), by row key. */
export function versionRows(rows: readonly UploadRow[]): string[][] {
  return [...versionGroups(rows.map(r => ({ id: r.key, parsed: { set: r.set, position: r.position, language: r.language, swatch: r.swatch, base: r.base, reason: r.reason } }))).values()]
}

/** The version of a group that is placed: the main language, else the first file. */
function placedVersion(group: readonly UploadRow[], mainLanguage: string) {
  return group.find(r => r.language === mainLanguage) ?? group[0]
}

export interface Placement { ops: MediaOp[]; sets: Array<{ ref: MediaSetRef; label: string; count: number }>; skipped: string[] }

/**
 * The plan edits that put the rows in their sets on one layer. A photo already in its set is skipped (named in
 * `skipped`), never refused; a swatch file sets its value's swatch. Positions are honoured in order; the rest go to the
 * end, in file order.
 */
export function placementOps(read: MediaRead, view: LayerView, rows: readonly UploadRow[]): Placement {
  const current = new Map(setRows(read, view, { skus: true }).map(r => [r.ref, r]))
  // The duplicate check may answer with another SKU's copy of a picture: the plan gets its library card, and any copy
  // or language version counts as the photo already there.
  const card = cardOf(read)
  const group = new Map(read.library.map(a => [a.id, a.versionGroupId ?? a.id]))
  const photo = (id: string) => group.get(card(id)) ?? card(id)
  const asset = (row: UploadRow) => card(placedAsset(row)!)
  const ready = rows.filter(r => placedAsset(r))
  const versions = versionRows(ready)
  const dropped = new Set(versions.flatMap(g => { const keep = placedVersion(ready.filter(r => g.includes(r.key)), read.mainLanguage); return g.filter(k => k !== keep.key) }))
  const ops: MediaOp[] = []
  const skipped: string[] = []
  const bySet = new Map<MediaSetRef, UploadRow[]>()
  for (const row of ready) {
    if (dropped.has(row.key)) continue
    if (row.swatch && row.set.startsWith('value:')) { ops.push({ op: 'swatch', value: row.set.slice('value:'.length), assetId: asset(row) }); continue }
    bySet.set(row.set, [...(bySet.get(row.set) ?? []), row])
  }
  const sets: Placement['sets'] = []
  for (const [ref, list] of bySet) {
    const have = new Set((current.get(ref)?.items ?? []).map(photo))
    const fresh = list.filter(r => { const id = asset(r); if (have.has(photo(id))) { skipped.push(r.fileName); return false } have.add(photo(id)); return true })
    if (!fresh.length) continue
    const placedAt = [...fresh.filter(r => r.position !== null).sort((a, b) => a.position! - b.position!), ...fresh.filter(r => r.position === null)]
    let length = current.get(ref)?.items.length ?? 0
    const atEnd: string[] = []
    for (const row of placedAt) {
      const id = asset(row)
      if (row.position === null || row.position - 1 >= length) atEnd.push(id)
      else { ops.push({ op: 'insert', set: ref, assetIds: [id], index: row.position - 1 }); length++ }
    }
    if (atEnd.length) ops.push({ op: 'insert', set: ref, assetIds: atEnd })
    sets.push({ ref, label: current.get(ref)?.label ?? ref, count: fresh.length })
  }
  return { ops, sets, skipped }
}

/**
 * What the library write needs: each new photo's language, and the groups of language versions. A photo that was
 * already in the library is never re-labelled; when it is one of the versions, the new files join it (and its group).
 */
export function libraryUpdate(rows: readonly UploadRow[]) {
  const ready = rows.filter(r => r.status.kind === 'new' || r.status.kind === 'exact')
  const id = (r: UploadRow) => placedAsset(r)!
  const groups = versionRows(ready).map(keys => {
    const members = keys.map(k => ready.find(r => r.key === k)!)
    const fresh = [...new Set(members.filter(r => r.status.kind === 'new').map(id))]
    const existing = members.find(r => r.status.kind === 'exact')
    return { ids: fresh, join: existing ? id(existing) : null }
  }).filter(g => g.ids.length > (g.join ? 0 : 1))
  return { languages: ready.filter(r => r.status.kind === 'new').map(r => ({ id: id(r), languageTag: r.language })), groups }
}

import { describe, expect, it } from 'vitest'
import { dispositionOf, previewModeOf } from '../preview/rules'
import { isCurrentVersion, newVersionRefusal, nextVersionNo, restoreRefusal, seriesRootOf, supersededBy, type VersionedFile } from './rules'

const ROOT = '00000000-0000-4000-8000-000000000001'
const file = (versionNo: number, status: string, fields: Partial<VersionedFile> = {}): VersionedFile => ({
  id: versionNo === 1 ? ROOT : `00000000-0000-4000-8000-00000000000${versionNo}`,
  seriesId: versionNo === 1 ? null : ROOT,
  versionNo,
  status,
  supersededAt: null,
  kind: 'DOCUMENT',
  ...fields,
})

describe('versions (COL-046, PLT-216)', () => {
  it('names the series by its first version and numbers the next one after the highest, a deleted one included', () => {
    expect(seriesRootOf(file(1, 'AVAILABLE'))).toBe(ROOT)
    expect(seriesRootOf(file(3, 'AVAILABLE'))).toBe(ROOT)
    expect(nextVersionNo([file(1, 'AVAILABLE'), file(3, 'DELETED'), file(2, 'AVAILABLE')])).toBe(4)
  })

  it('has one current version: available and not superseded', () => {
    expect(isCurrentVersion(file(2, 'AVAILABLE'))).toBe(true)
    expect(isCurrentVersion(file(1, 'AVAILABLE', { supersededAt: new Date() }))).toBe(false)
    expect(isCurrentVersion(file(3, 'QUARANTINED'))).toBe(false)
  })

  it('adds a version one at a time, never to a fiscal archive file or a deleted one', () => {
    const series = [file(1, 'AVAILABLE', { supersededAt: new Date() }), file(2, 'AVAILABLE')]
    expect(newVersionRefusal(series[1]!, series)).toBeNull()
    expect(newVersionRefusal(series[0]!, series)).toBeNull()
    expect(newVersionRefusal(series[1]!, [...series, file(3, 'PENDING_UPLOAD')])).toBe('Version 3 of this file is still uploading: confirm it or give it up first.')
    expect(newVersionRefusal(file(1, 'AVAILABLE', { kind: 'FISCAL_ARCHIVE' }), [])).toContain('fiscal archive')
    expect(newVersionRefusal(file(2, 'DELETED'), series)).toContain('deleted')
  })

  it('supersedes every earlier version not deleted nor superseded, whatever its status', () => {
    const series = [file(1, 'AVAILABLE', { supersededAt: new Date() }), file(2, 'QUARANTINED'), file(3, 'DELETED'), file(4, 'AVAILABLE'), file(5, 'AVAILABLE')]
    expect(supersededBy(series[4]!, series).map((version) => version.versionNo)).toEqual([2, 4])
    expect(supersededBy(file(1, 'AVAILABLE'), series)).toEqual([])
  })

  it('restores an earlier available version only', () => {
    const series = [file(1, 'AVAILABLE', { supersededAt: new Date() }), file(2, 'AVAILABLE')]
    expect(restoreRefusal(series[0]!, series)).toBeNull()
    expect(restoreRefusal(series[1]!, series)).toBe('This is already the current version.')
    expect(restoreRefusal(file(1, 'QUARANTINED', { supersededAt: new Date() }), series)).toContain('only an available version')
    expect(restoreRefusal(series[0]!, [...series, file(3, 'PENDING_UPLOAD')])).toContain('still uploading')
  })
})

describe('preview (COL-047)', () => {
  it('opens pictures and PDFs in the browser and downloads every other kind', () => {
    expect(['application/pdf', 'image/jpeg', 'IMAGE/PNG', 'image/webp; q=1'].map(previewModeOf)).toEqual(['inline', 'inline', 'inline', 'inline'])
    expect(['image/heic', 'text/csv', 'application/xml', 'audio/webm', 'application/dxf'].map(previewModeOf)).toEqual(['download', 'download', 'download', 'download', 'download'])
  })

  it('says inline or attachment with an ASCII fallback and the UTF-8 name', () => {
    expect(dispositionOf('inline', 'Scheda "tecnica" è.pdf')).toBe(`inline; filename="Scheda _tecnica_ _.pdf"; filename*=UTF-8''Scheda%20%22tecnica%22%20%C3%A8.pdf`)
    expect(dispositionOf('download', 'a.dxf')).toBe(`attachment; filename="a.dxf"; filename*=UTF-8''a.dxf`)
  })
})

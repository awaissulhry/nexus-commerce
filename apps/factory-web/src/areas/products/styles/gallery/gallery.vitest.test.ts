import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { ROWS } from '../demo/fixtures'
import { designScreen as galleryScreen } from './fixtures'
import { cardsOf, galleryOn, lookPages, selectionAfter, swatchColour, withGallery } from './gallery-model'
import { designScreen as picturesScreen } from '../record/gallery/fixtures'
import { addCallout, calloutsToSend, captionToSend, draftsOf, fileProblem, galleryHeld, galleryProblem, movedOrder, NO_GALLERY, pictureSrc } from '../record/gallery/gallery-model'
import { designScreen as patternsScreen } from '../record/files-w2b/fixtures'
import { kindsOpen, noteToSend, NO_PATTERNS, patternsHeld, patternsProblem, rowHeld, sizesWords } from '../record/files-w2b/patterns-model'
import { PatternTypeError } from '../record/files-w2b/api'
import { designScreen as publicPictureScreen } from '../../../../links/public-doc/picture/fixtures'
import { publicDocPictureUrl } from '../../../../links/public-doc/picture/model'

/** The ready view of a design case's section (made-up data). */
const picturesView = () => {
  const part = picturesScreen.cases.find((entry) => entry.id === 'owner')!.model.gallery!.part
  if (part.status !== 'ready') throw new Error('not ready')
  return part.value
}
const patternsView = (id = 'owner') => {
  const part = patternsScreen.cases.find((entry) => entry.id === id)!.model.patternFiles!.part
  if (part.status !== 'ready') throw new Error('not ready')
  return part.value
}

describe('Styles › Gallery (SCR-303)', () => {
  it('keeps the gallery in the address beside the filters, so a saved view keeps it', () => {
    expect(galleryOn(new URLSearchParams('view=waiting&mode=gallery'))).toBe(true)
    expect(galleryOn(new URLSearchParams('mode=board'))).toBe(false)
    expect(withGallery('?view=waiting&q=jkt', true)).toBe('?view=waiting&q=jkt&mode=gallery')
    expect(withGallery('?mode=gallery&view=waiting', false)).toBe('?view=waiting')
    expect(withGallery('', false)).toBe('')
  })

  it('makes a card of each row with its picture and swatches; a style without a main picture has none', () => {
    const model = galleryScreen.cases.find((entry) => entry.id === 'owner')!.model
    const cards = cardsOf(model.rows.items!, model.gallery!.looks)
    expect(cards).toHaveLength(model.rows.items!.length)
    expect(cards.find((card) => card.row.code === 'DEMO-JKT-01')).toMatchObject({ caption: 'Nero, davanti', pictures: 6, waiting: false })
    expect(cards.find((card) => card.row.code === 'DEMO-JKT-01')!.src).toMatch(/^data:image\/svg\+xml/)
    expect(cards.find((card) => card.row.code === 'DEMO-PNT-02')!.src).toBeNull()
    expect(cardsOf(ROWS.slice(0, 1), { status: 'loading' })[0]).toMatchObject({ src: null, waiting: true, swatches: [] })
    // A store address goes through this app's /api; anything else is not drawn.
    const look = { styleId: ROWS[0]!.id, picture: { id: ROWS[0]!.id, kind: 'PHOTO' as const, caption: null, look: { url: '/local-files?token=abc' } }, pictures: 1, colourways: [] }
    expect(cardsOf(ROWS.slice(0, 1), { status: 'ready', byStyle: { [ROWS[0]!.id]: look }, at: 'x' })[0]!.src).toBe('/api/local-files?token=abc')
    const outside = { ...look, picture: { ...look.picture, look: { url: 'ftp://elsewhere/x' } } }
    expect(cardsOf(ROWS.slice(0, 1), { status: 'ready', byStyle: { [ROWS[0]!.id]: outside }, at: 'x' })[0]!.src).toBeNull()
  })

  it('asks the looks 60 styles at a time, draws only a plain hex swatch, and selects a range with shift', () => {
    expect(lookPages(Array.from({ length: 130 }, (_, index) => `s${index}`)).map((page) => page.length)).toEqual([60, 60, 10])
    expect(swatchColour('#1A1A1A')).toBe('#1A1A1A')
    expect(swatchColour('red; background:url(x)')).toBeNull()
    expect(swatchColour(null)).toBeNull()
    const ids = ['a', 'b', 'c', 'd']
    expect(selectionAfter(ids, [], 'b', false, null)).toEqual(['b'])
    expect(selectionAfter(ids, ['b'], 'b', false, 'b')).toEqual([])
    expect(selectionAfter(ids, ['b'], 'd', true, 'b')).toEqual(['b', 'c', 'd'])
  })
})

describe('Sketches and pictures (SCR-304)', () => {
  it('holds what a role may not do, with its reason, and lets a role without files.upload arrange', () => {
    const view = picturesView()
    expect(galleryHeld({ ...NO_GALLERY, canManage: true, canArrange: true }, view, 'upload')).toBeNull()
    expect(galleryHeld({ ...NO_GALLERY, canManage: false, canArrange: true }, view, 'upload')).toBe('gallery.held.noUpload')
    expect(galleryHeld({ ...NO_GALLERY, canManage: false, canArrange: true }, view, 'arrange')).toBeNull()
    expect(galleryHeld({ ...NO_GALLERY }, view, 'arrange')).toBe('gallery.held.noRight')
    expect(galleryHeld({ ...NO_GALLERY, canManage: true, canArrange: true }, { ...view, refusal: 'x' }, 'arrange')).toBe('gallery.held.rule')
    expect(galleryHeld({ ...NO_GALLERY, canManage: true, canArrange: true }, { ...view, style: { ...view.style, status: 'ARCHIVED' } }, 'arrange')).toBe('gallery.held.archived')
    expect(galleryHeld({ ...NO_GALLERY, canManage: true, canArrange: true, offline: true }, view, 'arrange')).toBe('gallery.held.offline')
  })

  it('moves a picture to a place (clamped), nothing when it stays', () => {
    const view = picturesView()
    const ids = view.pictures.map((picture) => picture.id)
    expect(movedOrder(view, ids[2]!, 0)).toEqual([ids[2], ids[0], ids[1], ...ids.slice(3)])
    expect(movedOrder(view, ids[0]!, 99)).toEqual([...ids.slice(1), ids[0]])
    expect(movedOrder(view, ids[0]!, 0)).toBeNull()
  })

  it('edits callouts in percent and sends decimal shares; a callout without text or place says why', () => {
    const drafts = draftsOf([{ n: 2, x: '0.33', y: '0.58', text: 'Doppia impuntura' }, { n: 1, x: '0.5', y: '0.2405', text: 'Collo' }])
    expect(drafts.map((draft) => [draft.n, draft.x, draft.y])).toEqual([
      [1, '50', '24.1'],
      [2, '33', '58'],
    ])
    const added = addCallout(drafts, 0.123456, 1.2)
    expect(added.at(-1)).toEqual({ n: 3, x: '12.3', y: '100', text: '' })
    const { callouts, problems } = calloutsToSend([...added.slice(0, 2), { ...added[2]!, text: 'Zip' }, { n: 4, x: 'abc', y: '10', text: '' }])
    expect(callouts.slice(0, 3)).toEqual([
      { n: 1, x: '0.5', y: '0.241', text: 'Collo' },
      { n: 2, x: '0.33', y: '0.58', text: 'Doppia impuntura' },
      { n: 3, x: '0.123', y: '1', text: 'Zip' },
    ])
    expect(problems).toEqual({ 3: 'gallery.callouts.place' })
    expect(calloutsToSend([{ n: 1, x: '10', y: '10', text: ' ' }]).problems).toEqual({ 0: 'gallery.callouts.textProblem' })
  })

  it('checks a caption and a picture file, shows a store address through /api, and says a refusal in our words', () => {
    expect(captionToSend('  Davanti ')).toEqual({ caption: 'Davanti', problem: null })
    expect(captionToSend('')).toEqual({ caption: null, problem: null })
    expect(captionToSend('x'.repeat(201)).problem).toBe('gallery.edit.captionLong')
    expect(fileProblem({ type: 'image/heic', size: 10 }, 100)).toBe('gallery.add.wrongType')
    expect(fileProblem({ type: 'image/png', size: 101 }, 100)).toBe('gallery.add.tooBig')
    expect(fileProblem({ type: 'image/webp', size: 10 }, 100)).toBeNull()
    expect(pictureSrc({ look: { url: '/product/pictures/f1' } })).toBe('/api/product/pictures/f1')
    expect(pictureSrc({ look: { url: '/local-files?token=t' } })).toBe('/api/local-files?token=t')
    expect(pictureSrc({ look: null })).toBeNull()
    expect(galleryProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toBe('gallery.problem.moved')
    expect(galleryProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('gallery.problem.state')
    expect(galleryProblem(new Error('x'))).toBe('gallery.problem.write')
  })
})

describe('Pattern files (SCR-304-patterns)', () => {
  it('opens only markers and other files on a released revision, freezes its pattern, and says the sizes', () => {
    const released = patternsView('released')
    expect(kindsOpen(released)).toEqual(['MARKER', 'OTHER'])
    expect(kindsOpen(patternsView())).toEqual(['PATTERN', 'MARKER', 'CAD', 'OTHER'])
    const model = { ...NO_PATTERNS, canManage: true, canEdit: true }
    expect(rowHeld(model, released, released.files[0]!)).toBe('patterns.frozenRow')
    expect(rowHeld(model, released, released.files[1]!)).toBeNull()
    expect(patternsHeld({ ...model, canManage: false }, released, 'upload')).toBe('patterns.held.noUpload')
    expect(patternsHeld({ ...model, canEdit: false }, released, 'edit')).toBe('patterns.held.noRight')
    expect(sizesWords({ sizes: [] }, ['46', '48'])).toEqual({ key: 'patterns.sizes.all' })
    expect(sizesWords({ sizes: ['48', '46'] }, ['46', '48'])).toEqual({ key: 'patterns.sizes.some', params: { sizes: '46, 48' } })
    expect(noteToSend('a\nb').problem).toBe('patterns.field.noteLong')
    expect(patternsProblem(new PatternTypeError('x.mdl'))).toBe('patterns.add.wrongType')
  })
})

describe('the public DoC picture and the words', () => {
  it('reads the stripped picture at its own permanent address; the design cases carry a picture', () => {
    expect(publicDocPictureUrl('0F711ES7', '0190f0e2-7101-7000-8000-0000000000f1')).toBe('/api/public/doc/0F711ES7/picture/0190f0e2-7101-7000-8000-0000000000f1')
    expect(publicPictureScreen.cases[0]!.model.page?.picture).toMatchObject({ contentType: 'image/jpeg' })
  })

  it('has every word it uses in Italian and English', () => {
    const catalogue = (locale: string) => {
      const keys = new Set<string>()
      const walk = (node: Record<string, unknown>, prefix = '') => {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'object' && value !== null) walk(value as Record<string, unknown>, `${prefix}${key}.`)
          else keys.add(`${prefix}${key}`.replace(/_(one|other)$/, ''))
        }
      }
      walk(JSON.parse(readFileSync(join(__dirname, `../../../../../messages/${locale}/products-gallery.json`), 'utf8')))
      return keys
    }
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : /\.tsx?$/.test(name) && !name.includes('vitest') ? [join(dir, name)] : []))
    const used = new Set(
      [join(__dirname), join(__dirname, '../record/gallery'), join(__dirname, '../record/files-w2b')]
        .flatMap(files)
        .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/['`]((?:gallery|patterns|styles)\.[A-Za-z0-9_.]+)['`]/g)].map((match) => match[1]!))
        .filter((key) => !key.endsWith('.')),
    )
    for (const locale of ['en', 'it']) {
      const keys = catalogue(locale)
      expect([...used].filter((key) => !keys.has(key)), locale).toEqual([])
    }
    expect([...catalogue('en')].sort()).toEqual([...catalogue('it')].sort())
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE, outsideWordsOf } from '../i18n/messages'
import { everyCase, render, textOf } from '../record-thread/parts/testing'
import { isBatchSource, orderPicturePath, orderPictureSaver, PICTURE_ROUTES, readPictures } from './api'
import { forgetRecord, recordOf, resetPictureCache, want, type ReadPictures } from './cache'
import { designScreen } from './fixtures'
import { DESIGN_CHOICE, isPictureFile, openPictureState, orderPictureViewOf, pickPicture, pictureKindOf, refusedWith, saveHeldOf, saveRefusalOf, saveStarted, uploadDone, uploadStarted, type PictureChoice } from './order-picture'
import { OrderPictureWindowBody, OrderPictureWindowFoot, type OrderPictureWindowModel } from './view/OrderPictureWindowView'
import { pictureWordsFor } from './words'

/**
 * owb-b4 w4.3 (design § 5zi E, § 5zj A; owb-b23 "Shapes" POST …/picture) — the floor's source has no batch route, the command's four
 * doors and its answer parsed with this web's own zod, and the window "The picture of the order": the design vs a chosen file, Save
 * held with its reason (nothing changed, a save or an upload out, a stale version), a refusal in words, the portal's own words.
 * Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES: readonly PictureChoice[] = [
  { fileId: 'f-mock', name: 'mockup-race-suit.pdf', kind: 'mockup', small: { url: 'https://store.example.com/f-mock?sig=1', expiresAt: '2099-01-01T00:00:00.000Z' } },
  { fileId: 'f-pdf', name: 'logo-placement.pdf', kind: 'pdf', small: null },
]
const en = pictureWordsFor('en')
const noop = () => undefined

describe('the floor source and the command', () => {
  it('the floor\'s basket has no batch route: nothing is asked, nothing answers (its host gives the site-stamped picture)', async () => {
    expect(isBatchSource('basket')).toBe(false)
    expect(Object.keys(PICTURE_ROUTES)).not.toContain('basket')
    let asked = 0
    const api = { post: async () => (asked++, { pictures: [], asOf: 'x' }) } as unknown as Parameters<typeof readPictures>[0]
    expect(await readPictures(api, 'basket', ['b-1'])).toEqual([])
    expect(asked).toBe(0)
  })

  it('the four doors of orders.picture.set (owb-b23 b3.2)', () => {
    expect(orderPicturePath('office', 'order', 'o-1')).toBe('/sales/orders/o-1/picture')
    expect(orderPicturePath('office', 'request', 'r-1')).toBe('/sales/order-requests/r-1/picture')
    expect(orderPicturePath('portal', 'order', 'o-1')).toBe('/portal/sales-orders/o-1/picture')
    expect(orderPicturePath('portal', 'request', 'r-1')).toBe('/portal/order-requests/r-1/picture')
  })

  it('the save posts { fileId, version } to the host\'s door; the answer is parsed with this web\'s own zod (a missing pictureSetAt is null)', async () => {
    const posted: unknown[] = []
    const api = { post: async (path: string, init: { body: unknown; schema: { parse: (value: unknown) => unknown } }) => (posted.push({ path, body: init.body }), init.schema.parse({ pictureFileId: 'f-mock', version: 4, extra: 'ignored' })) } as unknown as Parameters<typeof orderPictureSaver>[0]
    const saved = await orderPictureSaver(api, '/sales/orders/o-1/picture')({ fileId: 'f-mock', version: 3 })
    expect(posted).toEqual([{ path: '/sales/orders/o-1/picture', body: { fileId: 'f-mock', version: 3 } }])
    expect(saved).toEqual({ pictureFileId: 'f-mock', pictureSetAt: null, version: 4 })
  })

  it('after a save the record\'s kept picture is forgotten: the next mount reads the new one', async () => {
    resetPictureCache()
    const read: ReadPictures = async (_source, ids) => ids.map((id) => ({ id, styleId: 's', styleCode: 'S', styleName: 'N', styleCount: 1, fileId: null, contentType: null, small: null }))
    await want('order', 'o-1', read)
    expect(recordOf('order', 'o-1')).not.toBeUndefined()
    forgetRecord('order', 'o-1')
    expect(recordOf('order', 'o-1')).toBeUndefined()
    resetPictureCache()
  })
})

describe('the window model', () => {
  it('opens on the saved picture: the design (default) or a chosen file; the design is always the first choice', () => {
    const atDesign = orderPictureViewOf(openPictureState({ fileId: null, version: 3 }, FILES))
    expect(atDesign.options.map((option) => option.value)).toEqual([DESIGN_CHOICE, 'f-mock', 'f-pdf'])
    expect(atDesign.options.map((option) => [option.checked, option.isNow])).toEqual([[true, true], [false, false], [false, false]])
    expect(atDesign.now).toEqual({ key: 'window.now.design' })
    const atFile = orderPictureViewOf(openPictureState({ fileId: 'f-mock', version: 3 }, FILES))
    expect(atFile.options.map((option) => [option.checked, option.isNow])).toEqual([[false, false], [true, true], [false, false]])
    expect(atFile.now).toEqual({ key: 'window.now.file', params: { name: 'mockup-race-suit.pdf' } })
    expect(orderPictureViewOf(openPictureState({ fileId: 'f-gone', version: 3 }, FILES)).now).toEqual({ key: 'window.now.other' })
    expect(atDesign.options.map((option) => option.hint.key)).toEqual(['window.designHint', 'window.kind.mockup', 'window.kind.pdf'])
    expect(atDesign.options[0]!.words).toEqual({ key: 'window.design' })
    expect(atDesign.options[1]!.words).toBeNull() // a file says its own name
  })

  it('"Use the design" picks the default back; a file picks the file', () => {
    const atFile = openPictureState({ fileId: 'f-mock', version: 3 }, FILES)
    expect(pickPicture(atFile, DESIGN_CHOICE).picked).toBeNull()
    expect(pickPicture(atFile, 'f-pdf').picked).toBe('f-pdf')
  })

  it('Save waits and says why: nothing changed · a save out · an upload out · a stale version (it stays held) · out of reach', () => {
    const atDesign = openPictureState({ fileId: null, version: 3 }, FILES)
    expect(saveHeldOf(atDesign)).toEqual({ key: 'window.held.same' })
    const chosen = pickPicture(atDesign, 'f-mock')
    expect(saveHeldOf(chosen)).toBeNull()
    expect(saveHeldOf(saveStarted(chosen))).toEqual({ key: 'window.held.saving' })
    expect(saveHeldOf(uploadStarted(chosen))).toEqual({ key: 'window.held.uploading' })
    const stale = refusedWith(chosen, 'STALE')
    expect(saveHeldOf(stale)).toEqual({ key: 'window.held.stale' })
    // A new pick never lifts a stale version: the window must be opened again.
    expect(saveHeldOf(pickPicture(stale, 'f-pdf'))).toEqual({ key: 'window.held.stale' })
    expect(saveHeldOf(refusedWith(chosen, 'GONE'))).toEqual({ key: 'window.held.gone' })
    // A refusal that is not about the version goes with the next pick.
    expect(saveHeldOf(pickPicture(refusedWith(chosen, 'NOT_ALLOWED'), 'f-pdf'))).toBeNull()
    expect(orderPictureViewOf(saveStarted(chosen)).closeHeld).toEqual({ key: 'window.held.closeSaving' })
    expect(orderPictureViewOf(chosen).closeHeld).toBeNull()
  })

  it('a refusal by the API error\'s kind, in words: 409 stale, 404/403 out of reach, 422 not an allowed file, else it failed', () => {
    expect(['conflict', 'not_found', 'forbidden', 'invalid', 'internal', null].map((kind) => saveRefusalOf(kind))).toEqual(['STALE', 'GONE', 'GONE', 'NOT_ALLOWED', 'FAILED', 'FAILED'])
    const chosen = pickPicture(openPictureState({ fileId: null, version: 3 }, FILES), 'f-mock')
    expect(orderPictureViewOf(refusedWith(chosen, 'STALE')).refusal).toEqual({ key: 'window.refused.stale' })
    expect(orderPictureViewOf(refusedWith(chosen, 'UPLOAD_FAILED')).refusal).toEqual({ key: 'window.refused.upload' })
    expect(en('window.refused.stale')).toBe('Someone changed the picture of this order a moment ago. Close the window and open it again to see it.')
    expect(en('window.held.stale')).toBe('The picture changed meanwhile. Close the window and open it again.')
  })

  it('an upload joins the choices first and is picked; only PNG, JPG, WebP or PDF', () => {
    const uploaded = uploadDone(uploadStarted(openPictureState({ fileId: null, version: 3 }, FILES)), { fileId: 'f-new', name: 'my-photo.png', kind: 'image', small: null })
    expect(uploaded.choices.map((choice) => choice.fileId)).toEqual(['f-new', 'f-mock', 'f-pdf'])
    expect(uploaded.picked).toBe('f-new')
    expect(uploaded.busy).toBe('idle')
    expect([{ type: 'image/png', name: 'a.png' }, { type: 'application/pdf', name: 'a.pdf' }, { type: '', name: 'b.JPG' }, { type: 'image/gif', name: 'c.gif' }, { type: 'text/csv', name: 'sizes.csv' }].map(isPictureFile)).toEqual([true, true, true, false, false])
    expect(pictureKindOf({ type: '', name: 'x.pdf' })).toBe('pdf')
    expect(pictureKindOf({ type: 'image/webp', name: 'x.webp' })).toBe('image')
  })
})

describe('the window drawn', () => {
  const model = (state = openPictureState({ fileId: 'f-mock', version: 3 }, FILES), canUpload = true): OrderPictureWindowModel => ({ open: true, number: 'Your order 12', subject: 'Race suits', record: { source: 'order', recordId: 'o-1' }, view: orderPictureViewOf(state), canUpload })

  it('the body: what it is now and who decides, the upload first, then the radios — the design first, each file with its kind; "The picture now" on the saved one', () => {
    const html = render(createElement(OrderPictureWindowBody, { model: model(), actions: { onPick: noop, onFiles: noop } }))
    const text = textOf(html)
    expect(text).toContain('Now: mockup-race-suit.pdf')
    expect(text).toContain('The customer decides it; you can set it for the customer.')
    expect(text.indexOf('A picture from your computer or phone')).toBeLessThan(text.indexOf('Use the design'))
    expect(text.indexOf('Use the design')).toBeLessThan(text.indexOf('logo-placement.pdf'))
    expect(text).toContain('A mockup: front and back')
    expect(text).toContain('A PDF: its first page')
    expect(html.match(/type="radio"/g)?.length).toBe(3)
    expect(html.match(/class="fw-opic-now-tag"/g)?.length).toBe(1)
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,application/pdf"')
  })

  it('no upload port: no upload field; no file: says so', () => {
    const html = render(createElement(OrderPictureWindowBody, { model: model(openPictureState({ fileId: null, version: 1 }, []), false), actions: { onPick: noop, onFiles: noop } }))
    expect(textOf(html)).not.toContain('A picture from your computer or phone')
    expect(textOf(html)).toContain('No image and no PDF is on this order yet.')
  })

  it('a refusal is said in a banner (a stale version as a warning, the rest as an alert)', () => {
    const chosen = pickPicture(openPictureState({ fileId: null, version: 3 }, FILES), 'f-mock')
    const stale = render(createElement(OrderPictureWindowBody, { model: model(refusedWith(chosen, 'STALE')), actions: { onPick: noop, onFiles: noop } }))
    expect(stale).toContain('nds-banner warning')
    expect(stale).toContain('role="status"')
    expect(render(createElement(OrderPictureWindowBody, { model: model(refusedWith(chosen, 'NOT_ALLOWED')), actions: { onPick: noop, onFiles: noop } }))).toContain('role="alert"')
  })

  it('the foot: Save held says why (aria-disabled + its reason), Cancel runs; while saving both wait', () => {
    const same = render(createElement(OrderPictureWindowFoot, { view: orderPictureViewOf(openPictureState({ fileId: null, version: 3 }, FILES)), actions: { onClose: noop, onSave: noop } }))
    expect(same).toContain('aria-description="This is the picture now. Choose another one first."')
    expect(same.match(/aria-disabled="true"/g)?.length).toBe(1)
    const saving = render(createElement(OrderPictureWindowFoot, { view: orderPictureViewOf(saveStarted(pickPicture(openPictureState({ fileId: null, version: 3 }, FILES), 'f-mock'))), actions: { onClose: noop, onSave: noop } }))
    expect(saving.match(/aria-disabled="true"/g)?.length).toBe(2)
    expect(textOf(saving)).toContain('Saving…')
  })

  it('the portal reads its own words ("You decide it", voi in Italian); the office keeps "tu"', () => {
    expect(pictureWordsFor('en', 'outside')('window.who')).toContain('You decide it.')
    expect(pictureWordsFor('it', 'outside')('window.who')).toContain('La decidete voi.')
    expect(pictureWordsFor('it')('window.who')).toContain('puoi impostarla tu')
    for (const locale of LOCALES) for (const key of Object.keys(outsideWordsOf(locale, 'record-picture'))) expect(CATALOGUE[locale]['record-picture']?.[key], `${locale} ${key}: an outside word names a key the catalogue has`).toBeTruthy()
  })

  it('every design case draws in both languages with no window key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(html, `${locale} ${id}`).not.toMatch(/window\.(title|now|held|refused|kind|design|choose|upload|save|cancel|who|isNow|noFiles)/)
  })

  it('the window\'s CSS: layout only, DS tokens, no raw colour', () => {
    expect(readFileSync(join(HERE, 'order-picture.css'), 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})

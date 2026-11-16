import { describe, expect, it } from 'vitest'
import { isStorageKey } from '@nexus/factory-domain/files/keys'
import { decodeJpeg, jpegScaleFor, ZIGZAG } from './codec/jpeg-decode'
import { encodeJpeg, STANDARD_TABLES } from './codec/jpeg-encode'
import { CodecError, orient, shrink, type Picture } from './codec/picture'
import { decodePng, encodePng } from './codec/png'
import { hasSmallPreview, makeSmallPreview, SMALL_EDGE, smallKeyOf } from './small'

/**
 * The small previews' codec (B-TH-063): the hand-written JPEG and PNG readers and writers, the turn by EXIF orientation,
 * the area-average shrink and the preview's key. The JPEG fixtures were written by libjpeg's cjpeg from one made-up 48 x 32
 * picture of four flat quarters (red, green, blue, white) and checked pixel for pixel against libjpeg's djpeg (box
 * upsampling) when the codec was written; the PNG fixtures are tiny made-up pictures. Run with
 * `cd apps/factory-api && npx vitest run src/platform/files/thumbs/small.vitest.test.ts`.
 */

const b64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'base64'))

const JPEG = {
  base420: (
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGB' +
    'YUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAg' +
    'ADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcJCP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAXAQADAQAAAAAAAAAAAAAAAAAFBw' +
    'gJ/8QAHxEBAAAFBQEAAAAAAAAAAAAAAAVCgYPBBwhERcLD/9oADAMBAAIRAxEAPwCJAFUv0XVCl1BYjJXCIdy/T3/iAAyIHG4DXBRo34YDt+CL' +
    '1P4dzwNQ6emQAixl/9k='
  ),
  prog420r: (
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGB' +
    'YUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAAg' +
    'ADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAYIB//EABcBAAMBAAAAAAAAAAAAAAAAAAQGBwX/3QAEAAP/2gAMAwEAAhADEAAAAY' +
    'gKl+XcJdhRAA4h/9Dj4umK35gPfiKaCKb/AP/EABQQAQAAAAAAAAAAAAAAAAAAACD/3QAEAAb/2gAIAQEAAQUCX//QX//RX//SX//EABsRAAIB' +
    'BQAAAAAAAAAAAAAAAAAQBAdBRILC/90ABAAD/9oACAEDAQE/ASpeHvwv/9Aj3X//xAAbEQACAQUAAAAAAAAAAAAAAAAAEAQGQUOCwf/aAAgBAg' +
    'EBPwEkWX//0Cp8O3F//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/dAAQABv/aAAgBAQAGPwJf/9Bf/9Ff/9Jf/8QAFBABAAAAAAAAAAAAAAAAAAAA' +
    'IP/aAAgBAQABPyFf/9Bf/9Ff/9Jf/90ABAAD/9oADAMBAAIAAwAAABD+sD//0AQQP//EABYRAQEBAAAAAAAAAAAAAAAAABDBAP/aAAgBAwEBPx' +
    'Br/9DTp//EABYRAQEBAAAAAAAAAAAAAAAAABDBAP/aAAgBAgEBPxDXh//QZ//EABQQAQAAAAAAAAAAAAAAAAAAACD/3QAEAAb/2gAIAQEAAT8Q' +
    'X//QX//RX//SX//Z'
  ),
  base422r: (
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGB' +
    'YUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAg' +
    'ADADASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhBy' +
    'JxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT' +
    'lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAA' +
    'AAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRom' +
    'JygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExc' +
    'bHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAC/9oADAMBAAIRAxEAPwDxKivyo/v0K91rxcx+x8/0P4h+kv8A8yf/ALj/APuE' +
    '/9CxRX87n8fnhVFfZn+3p//R8Sr3WvxDMfsfP9D3/pL/APMn/wC4/wD7hCivGP4gP//S+P6K/ug+MCv34r8L8T/+YP8A7if+2HtZd9v5fqf/0/' +
    '04ooA/Aeiv7oPjD//U+P6/fiv3TxP/AOYP/uJ/7YeNl32/l+oUV+Fnsn//2Q=='
  ),
  grey: (
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGB' +
    'YUGBIUFRT/wAALCAAgADABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh' +
    'MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhI' +
    'WGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APEq' +
    'KK91oorwqiivdaKK+N6KK/fiiivwHoor9+KKK//Z'
  ),
}

const PNG = {
  /** 16 x 8, 2-bit palette with tRNS: the top-left quarter clear. */
  palette: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAIAgMAAACNGJcEAAAADFBMVEVMaXEUtNwUtB7IKNx9IxC1AAAAAXRSTlMAQObYZgAAAAlwSFlzAAAD6AAAA+gBtXtSawAAABZJREFUeJxjYGBYtYoBjfj/PzQUjQAACdcP8RllOC8AAAAASUVORK5CYII=',
  /** 16 x 8, RGBA, interlaced (Adam7). */
  interlaced:
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAAGHcU8BAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVR4nGM4oSHHILJF7j8DEuPOfxAW2QLBYBmYLH4VJ9BUYuhA10mKCXIUW3GHNDecIGAlQTeSYQCqEwk5maAfSTUAAL7MDDBcFLQTAAAAAElFTkSuQmCC',
  /** 16 x 8, grey + alpha, 16 bits per sample. */
  grey16: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAIEAQAAAAK72tfAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVR4nGPIyGBgwIdnz/7/Hx9mGAYGVFT8/48PL1uGHw8DAwAtFUeQ8R3rRQAAAABJRU5ErkJggg==',
}

const RED = [220, 30, 30]
const GREEN = [30, 200, 40]
const BLUE = [30, 40, 210]
const WHITE = [245, 245, 245]

const pixel = (picture: Picture, x: number, y: number): number[] => Array.from(picture.data.subarray((y * picture.width + x) * picture.channels, (y * picture.width + x + 1) * picture.channels))
const near = (actual: number[], expected: number[], tolerance = 4): void => {
  expect(actual.length).toBeGreaterThanOrEqual(expected.length)
  expected.forEach((value, index) => expect(Math.abs(actual[index]! - value), `channel ${index}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance))
}
/** A made-up picture: a horizontal and a vertical gradient, a disc in the middle. */
function synthetic(width: number, height: number, channels: 3 | 4 = 3): Picture {
  const data = new Uint8ClampedArray(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels
      const disc = Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) / 4
      data[at] = (x * 255) / width
      data[at + 1] = (y * 255) / height
      data[at + 2] = disc ? 230 : 60
      if (channels === 4) data[at + 3] = x < width / 2 ? 255 : 0
    }
  }
  return { width, height, channels, data }
}
/** The JPEG with an EXIF block that holds only the orientation, after its JFIF header (what the stripped copy writes). */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
  const body = [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), ...tiff]
  const app1 = [0xff, 0xe1, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body]
  const app0End = 4 + ((jpeg[4]! << 8) | jpeg[5]!)
  return Uint8Array.from([...jpeg.subarray(0, app0End), ...app1, ...jpeg.subarray(app0End)])
}
const segments = (jpeg: Uint8Array): number[] => {
  const markers: number[] = []
  let at = 2
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]!
    markers.push(marker)
    if (marker === 0xda) break
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!)
  }
  return markers
}

describe('the JPEG tables', () => {
  it('the zigzag order is the specification\'s: a permutation of the 64 cells', () => {
    expect(Array.from(ZIGZAG.subarray(0, 10))).toEqual([0, 1, 8, 16, 9, 2, 3, 10, 17, 24])
    expect(ZIGZAG[63]).toBe(63)
    expect(new Set(ZIGZAG).size).toBe(64)
  })

  it('each standard AC table codes every run and size once, with end-of-block and the 16-zero run', () => {
    for (const table of [STANDARD_TABLES.acLuminance, STANDARD_TABLES.acChrominance]) {
      expect(table.counts.reduce((sum: number, count: number) => sum + count, 0)).toBe(table.symbols.length)
      const needed = [0x00, 0xf0, ...Array.from({ length: 16 }, (_, run) => Array.from({ length: 10 }, (__, size) => (run << 4) | (size + 1))).flat()]
      expect(new Set(table.symbols).size).toBe(162)
      expect([...needed].sort((a, b) => a - b)).toEqual([...table.symbols].sort((a, b) => a - b))
    }
    for (const table of [STANDARD_TABLES.dcLuminance, STANDARD_TABLES.dcChrominance]) expect(table.counts.reduce((sum: number, count: number) => sum + count, 0)).toBe(12)
  })
})

describe('reading a JPEG', () => {
  it.each(Object.keys(JPEG) as (keyof typeof JPEG)[])('%s: the four quarters come back in their colours', (name) => {
    const picture = decodeJpeg(b64(JPEG[name]), { scale: 8 })
    expect([picture.width, picture.height, picture.channels]).toEqual([48, 32, 3])
    const grey = name === 'grey'
    const luma = ([r, g, b]: number[]) => Math.round(0.299 * r! + 0.587 * g! + 0.114 * b!)
    for (const [x, y, colour] of [[12, 8, RED], [36, 8, GREEN], [12, 24, BLUE], [36, 24, WHITE]] as const) {
      near(pixel(picture, x, y), grey ? [luma([...colour]), luma([...colour]), luma([...colour])] : [...colour])
    }
  })

  it('at a reduced size each block becomes its mean (1/8) or its lowest frequencies (1/4, 1/2)', () => {
    const eighth = decodeJpeg(b64(JPEG.base420), { scale: 1 })
    expect([eighth.width, eighth.height]).toEqual([6, 4])
    near(pixel(eighth, 0, 0), RED, 2)
    near(pixel(eighth, 5, 3), WHITE, 2)
    const quarter = decodeJpeg(b64(JPEG.prog420r), { scale: 2 })
    expect([quarter.width, quarter.height]).toEqual([12, 8])
    near(pixel(quarter, 2, 2), RED)
    near(pixel(quarter, 9, 6), WHITE)
    const half = decodeJpeg(b64(JPEG.base422r), { scale: 4 })
    expect([half.width, half.height]).toEqual([24, 16])
    near(pixel(half, 18, 4), GREEN)
  })

  it('picks the reduction that keeps the preview at least as large as asked', () => {
    expect(jpegScaleFor(4032, 3024, 320)).toBe(1)
    expect(jpegScaleFor(1280, 960, 320)).toBe(2)
    expect(jpegScaleFor(800, 600, 320)).toBe(4)
    expect(jpegScaleFor(300, 200, 320)).toBe(8)
  })

  it('reads the EXIF orientation the stripped copy keeps, and turns the pixels with it', () => {
    const turned = decodeJpeg(withOrientation(b64(JPEG.base420), 6), { scale: 8 })
    expect(turned.orientation).toBe(6)
    const upright = orient(turned, turned.orientation)
    expect([upright.width, upright.height]).toEqual([32, 48])
    // Turned right: the top-left (red) quarter is now at the top right, the bottom-left (blue) one at the top left.
    near(pixel(upright, 24, 12), RED)
    near(pixel(upright, 8, 12), BLUE)
    near(pixel(upright, 8, 36), WHITE)
    for (const orientation of [1, 2, 3, 4, 5, 7, 8]) {
      const other = orient(turned, orientation)
      expect([other.width, other.height]).toEqual(orientation >= 5 ? [32, 48] : [48, 32])
    }
    near(pixel(orient(turned, 3), 12, 8), WHITE)
    near(pixel(orient(turned, 2), 12, 8), GREEN)
    near(pixel(orient(turned, 4), 12, 8), BLUE)
    near(pixel(orient(turned, 8), 8, 12), GREEN)
  })

  it('refuses what it does not read, in words', () => {
    expect(() => decodeJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(CodecError)
    const jpeg = b64(JPEG.base420)
    const lossless = Uint8Array.from(jpeg)
    const sof = segments(jpeg).indexOf(0xc0)
    expect(sof).toBeGreaterThan(0)
    for (let at = 0; at < lossless.length - 1; at++) if (lossless[at] === 0xff && lossless[at + 1] === 0xc0) lossless[at + 1] = 0xc3
    expect(() => decodeJpeg(lossless)).toThrow(/Lossless/)
    expect(() => decodeJpeg(jpeg.subarray(0, 200))).toThrow(CodecError)
  })
})

describe('writing a JPEG', () => {
  it('a baseline 4:2:0 JPEG with a JFIF header, no EXIF, that reads back as the same picture', () => {
    const source = synthetic(70, 45)
    const jpeg = encodeJpeg(source, 90)
    expect([jpeg[0], jpeg[1], jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(segments(jpeg)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda])
    const back = decodeJpeg(jpeg, { scale: 8 })
    expect([back.width, back.height]).toEqual([70, 45])
    let error = 0
    for (let index = 0; index < source.data.length; index++) error += Math.abs(source.data[index]! - back.data[index]!)
    expect(error / source.data.length).toBeLessThan(4)
  })

  it('lays transparency on white', () => {
    const back = decodeJpeg(encodeJpeg(synthetic(32, 16, 4)), { scale: 8 })
    near(pixel(back, 28, 2), [255, 255, 255], 6)
  })
})

describe('PNG', () => {
  it('reads a 2-bit palette picture with its transparency', () => {
    const picture = decodePng(b64(PNG.palette))
    expect([picture.width, picture.height, picture.channels]).toEqual([16, 8, 4])
    expect(pixel(picture, 2, 1)[3]).toBe(0)
    near(pixel(picture, 12, 1), [20, 180, 30, 255], 0)
    near(pixel(picture, 2, 6), [200, 40, 220, 255], 0)
  })

  it('reads an interlaced RGBA picture and a 16-bit grey one with alpha', () => {
    const interlaced = decodePng(b64(PNG.interlaced))
    near(pixel(interlaced, 12, 6), [20, 180, 220, 255], 0)
    expect(pixel(interlaced, 1, 1)[3]).toBe(0)
    const grey = decodePng(b64(PNG.grey16))
    expect(pixel(grey, 1, 1)[3]).toBe(0)
    expect(pixel(grey, 14, 6)[3]).toBe(255)
    const [r, g, b] = pixel(grey, 14, 6)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  it('writes RGB when every pixel is opaque, RGBA otherwise, and reads back exactly', () => {
    const opaque = synthetic(33, 21)
    const rgb = encodePng(opaque)
    expect(rgb[25]).toBe(2)
    expect(Array.from(decodePng(rgb).data).filter((_, index) => index % 4 !== 3)).toEqual(Array.from(opaque.data))
    const clear = synthetic(33, 21, 4)
    const rgba = encodePng(clear)
    expect(rgba[25]).toBe(6)
    expect(Array.from(decodePng(rgba).data)).toEqual(Array.from(clear.data))
  })

  it('refuses a file that is not a PNG or is damaged', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(CodecError)
    const damaged = b64(PNG.interlaced)
    damaged.fill(0, 60, 90)
    expect(() => decodePng(damaged)).toThrow(CodecError)
  })
})

describe('shrinking', () => {
  it('averages the area each target pixel covers, keeps the aspect ratio, never enlarges', () => {
    const source = decodeJpeg(b64(JPEG.base420), { scale: 8 })
    const small = shrink(source, 12)
    expect([small.width, small.height]).toEqual([12, 8])
    near(pixel(small, 2, 2), RED)
    near(pixel(small, 9, 6), WHITE)
    expect(shrink(source, 100)).toBe(source)
  })

  it('a clear pixel lends no colour to its opaque neighbours', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0])
    const small = shrink({ width: 2, height: 1, channels: 4, data }, 1)
    expect(pixel(small, 0, 0)).toEqual([255, 0, 0, 128])
  })
})

describe('the small preview', () => {
  it('a large JPEG: reduced to 320 px on its longer side, a JPEG without EXIF', () => {
    const large = encodeJpeg(synthetic(960, 640), 90)
    const small = makeSmallPreview(large, 'image/jpeg')
    expect(small).toMatchObject({ made: 'RESIZED', width: SMALL_EDGE, height: 213, reason: null })
    expect(segments(small.bytes)).not.toContain(0xe1)
    expect(decodeJpeg(small.bytes, { scale: 8 })).toMatchObject({ width: 320, height: 213 })
    expect(small.bytes.length).toBeLessThan(large.length)
  })

  it('a turned photo comes out the right way up', () => {
    const turned = withOrientation(encodeJpeg(synthetic(900, 600), 90), 6)
    expect(makeSmallPreview(turned, 'image/jpeg')).toMatchObject({ made: 'RESIZED', width: 213, height: 320 })
  })

  it('a large PNG keeps its transparency', () => {
    const small = makeSmallPreview(encodePng(synthetic(640, 400, 4)), 'image/png')
    expect(small).toMatchObject({ made: 'RESIZED', width: 320, height: 200 })
    const back = decodePng(small.bytes)
    expect(pixel(back, 300, 10)[3]).toBe(0)
    expect(pixel(back, 10, 10)[3]).toBe(255)
  })

  it('a picture already small is kept as it is; a WebP or a damaged picture is kept as its stripped copy, with the reason', () => {
    const tiny = b64(JPEG.base420)
    expect(makeSmallPreview(tiny, 'image/jpeg')).toMatchObject({ made: 'COPIED', bytes: tiny, width: 48, height: 32, reason: null })
    const webp = Uint8Array.from(Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 made-up', 'latin1'))
    expect(makeSmallPreview(webp, 'image/webp')).toMatchObject({ made: 'COPIED', bytes: webp })
    expect(makeSmallPreview(webp, 'image/webp').reason).toMatch(/stripped copy/)
    const damaged = tiny.subarray(0, 150)
    expect(makeSmallPreview(damaged, 'image/jpeg')).toMatchObject({ made: 'COPIED', bytes: damaged })
    expect(makeSmallPreview(damaged, 'image/jpeg').reason).not.toBeNull()
  })

  it('its key: the stripped copy\'s prefix, a key the store accepts, one per copy, nothing a file id leads to', () => {
    const thumbnailKey = 't/0190f0e2-0000-7000-8000-000000000001/c/0190f0e2-0000-7000-8000-000000000002/2026/2b0a6c1e-3f4d-4e5f-8a9b-0c1d2e3f4a5b'
    const key = smallKeyOf(thumbnailKey)
    expect(isStorageKey(key)).toBe(true)
    expect(key).not.toBe(thumbnailKey)
    expect(key.startsWith('t/0190f0e2-0000-7000-8000-000000000001/c/0190f0e2-0000-7000-8000-000000000002/2026/')).toBe(true)
    expect(smallKeyOf(thumbnailKey)).toBe(key)
    expect(smallKeyOf(thumbnailKey.replace('2b0a6c1e', '2b0a6c1f'))).not.toBe(key)
  })

  it('a file has it once its stripped copy exists (a picture the copy job handles)', () => {
    expect(hasSmallPreview({ thumbnailKey: 'k', contentType: 'image/jpeg' })).toBe(true)
    expect(hasSmallPreview({ thumbnailKey: null, contentType: 'image/jpeg' })).toBe(false)
    expect(hasSmallPreview({ thumbnailKey: 'k', contentType: 'application/pdf' })).toBe(false)
  })
})

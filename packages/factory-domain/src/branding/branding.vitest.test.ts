import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { composeDocument } from '../documents/compose'
import { attachDocumentLogo, type CompanyLegal } from '../documents/model'
import { sampleDocument } from '../documents/sample'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { brandingBody, logoUploadBody } from './contracts'
import { BRANDING_MANAGE } from './permissions'
import {
  brandingOf,
  changedFields,
  companyNameOf,
  imageSizeOf,
  logoTypeOf,
  logoUploadProblems,
  normaliseAccent,
  NO_BRANDING,
  publicLogoPath,
  shownNames,
  type BrandingInput,
} from './rules'

/** A made-up solid PNG (8-bit RGB) of the given size. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array.from({ length: width }, () => [0x1f, 0x5f, 0xa8]).flat()])))
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]))
}

const EMPTY: BrandingInput = { logoFileId: null, logoDarkFileId: null, accentColour: null, senderDisplayName: null, portalLabel: null }
const LOGO = '01900000-0000-7000-8000-000000000001'
const DARK = '01900000-0000-7000-8000-000000000002'

describe('company branding (B-W2b-161)', () => {
  it('normalises an accent to #rrggbb in lower case, or refuses it', () => {
    expect(normaliseAccent('#1F5FA8')).toBe('#1f5fa8')
    expect(normaliseAccent(' #abc ')).toBe('#aabbcc')
    expect(normaliseAccent('1f5fa8')).toBeNull()
    expect(normaliseAccent('#12345')).toBeNull()
    expect(normaliseAccent('red')).toBeNull()
    expect(normaliseAccent(null)).toBeNull()
    expect(brandingOf({ ...EMPTY, accentColour: 'blue' }).problems).toEqual([{ path: 'body/accentColour', message: expect.stringContaining('#rrggbb') }])
    expect(brandingOf({ ...EMPTY, accentColour: '  ' }).values.accentColour).toBeNull()
  })

  it('keeps names one line, within the database bounds, and the sender name safe for a mail header', () => {
    expect(brandingOf({ ...EMPTY, senderDisplayName: '  Pelletteria Esempio  ', portalLabel: ' Portale Esempio ' }).values).toMatchObject({ senderDisplayName: 'Pelletteria Esempio', portalLabel: 'Portale Esempio' })
    expect(brandingOf({ ...EMPTY, senderDisplayName: '', portalLabel: '   ' }).values).toMatchObject({ senderDisplayName: null, portalLabel: null })
    const paths = (input: Partial<BrandingInput>) => brandingOf({ ...EMPTY, ...input }).problems.map((problem) => problem.path)
    expect(paths({ senderDisplayName: 'x'.repeat(81) })).toEqual(['body/senderDisplayName'])
    expect(paths({ senderDisplayName: 'x'.repeat(80) })).toEqual([])
    expect(paths({ senderDisplayName: 'Esempio <noreply@example.com>' })).toEqual(['body/senderDisplayName'])
    expect(paths({ senderDisplayName: 'Esempio "Moto"' })).toEqual(['body/senderDisplayName'])
    expect(paths({ senderDisplayName: 'Esempio\r\nBcc: x@example.com' })).toContain('body/senderDisplayName')
    expect(paths({ portalLabel: 'p'.repeat(61) })).toEqual(['body/portalLabel'])
    expect(paths({ portalLabel: 'Portale due' })).toEqual(['body/portalLabel'])
    expect(paths({ portalLabel: 'Portale <Esempio>' })).toEqual([])
  })

  it('takes a logo for dark pages only beside a different logo for light ones', () => {
    const paths = (input: Partial<BrandingInput>) => brandingOf({ ...EMPTY, ...input }).problems.map((problem) => problem.path)
    expect(paths({ logoDarkFileId: DARK })).toEqual(['body/logoDarkFileId'])
    expect(paths({ logoFileId: LOGO, logoDarkFileId: LOGO })).toEqual(['body/logoDarkFileId'])
    expect(paths({ logoFileId: LOGO, logoDarkFileId: DARK })).toEqual([])
    expect(paths({ logoFileId: LOGO })).toEqual([])
  })

  it('names the fields that changed, in order', () => {
    expect(changedFields(NO_BRANDING, NO_BRANDING)).toEqual([])
    expect(changedFields(NO_BRANDING, { ...NO_BRANDING, portalLabel: 'P', logoFileId: LOGO })).toEqual(['logo', 'portalLabel'])
    expect(changedFields({ ...NO_BRANDING, accentColour: '#1f5fa8' }, { ...NO_BRANDING, accentColour: '#1f5fa8', logoDarkFileId: DARK, senderDisplayName: 'S' })).toEqual(['logoDark', 'senderDisplayName'])
  })

  it('knows a PNG or a JPEG by its first bytes, and nothing else', () => {
    expect(logoTypeOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(logoTypeOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(logoTypeOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(logoTypeOf(new Uint8Array())).toBeNull()
  })

  it('reads a picture\'s size from its header (the PDF keeps the logo\'s proportions)', () => {
    expect(imageSizeOf(png(120, 40))).toEqual({ width: 120, height: 40 })
    // A JPEG: SOI, an APP0 segment of 16 bytes, then SOF0 with height 30 and width 90.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x5a, 0x03, 0, 0, 0, 0])
    expect(imageSizeOf(jpeg)).toEqual({ width: 90, height: 30 })
    expect(imageSizeOf(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull()
    expect(imageSizeOf(new TextEncoder().encode('GIF89a'))).toBeNull()
  })

  it('carries the company\'s logo onto the composed document, never as data', async () => {
    const company: CompanyLegal = {
      legalName: 'Pelletteria Esempio S.r.l.',
      address: { line1: 'Via Esempio 1', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' },
      vatNumber: 'IT12345670009',
      fiscalCode: '12345670009',
      reaOffice: 'FI',
      reaNumber: '123456',
      shareCapital: '10000.00',
      currency: 'EUR',
    }
    const bytes = png(10, 10)
    const logo = { fileId: LOGO, load: async () => bytes }
    const withLogo = attachDocumentLogo({ ...company }, logo)
    expect(withLogo.logo).toBe(logo)
    expect(Object.keys(withLogo)).not.toContain('logo')
    expect(JSON.parse(JSON.stringify(withLogo))).toEqual(company)
    const composed = composeDocument(sampleDocument('QUOTE', 'it', withLogo, '2026-11-04'))
    expect(composed.issuer.logo).toBe(logo)
    expect(Object.keys(composed.issuer)).toEqual(['heading', 'name', 'lines'])
    expect(await composed.issuer.logo?.load()).toBe(bytes)
    expect(composeDocument(sampleDocument('QUOTE', 'it', company, '2026-11-04')).issuer.logo).toBeUndefined()
  })

  it('takes PNG or JPEG uploads up to 1 MiB', () => {
    expect(logoUploadProblems({ contentType: 'image/png', sizeBytes: 1024 })).toEqual([])
    expect(logoUploadProblems({ contentType: 'Image/JPEG; charset=x', sizeBytes: 1024 * 1024 })).toEqual([])
    expect(logoUploadProblems({ contentType: 'image/svg+xml', sizeBytes: 10 }).map((problem) => problem.path)).toEqual(['body/contentType'])
    expect(logoUploadProblems({ contentType: 'image/webp', sizeBytes: 10 }).map((problem) => problem.path)).toEqual(['body/contentType'])
    expect(logoUploadProblems({ contentType: 'image/png', sizeBytes: 1024 * 1024 + 1 }).map((problem) => problem.path)).toEqual(['body/sizeBytes'])
  })

  it('falls back to the company name: the trade name, else the legal name', () => {
    expect(companyNameOf({ legalName: 'Esempio S.r.l.', tradeName: 'Esempio Moto' })).toBe('Esempio Moto')
    expect(companyNameOf({ legalName: ' Esempio S.r.l. ', tradeName: ' ' })).toBe('Esempio S.r.l.')
    expect(shownNames({ legalName: 'Esempio S.r.l.' }, null)).toEqual({ portal: 'Esempio S.r.l.', sender: 'Esempio S.r.l.' })
    expect(shownNames({ legalName: 'Esempio S.r.l.' }, { portalLabel: 'Portale Esempio', senderDisplayName: null })).toEqual({ portal: 'Portale Esempio', sender: 'Esempio S.r.l.' })
    expect(publicLogoPath('c', 'f')).toBe('/branding/public/c/logo/f')
  })

  it('declares its step-up permission, gives it to the administrator, and its event reaches documents.view', () => {
    expect(FACTORY_PERMISSIONS.get(BRANDING_MANAGE)).toMatchObject({ area: 'documents', risk: 'stepUp' })
    expect(ROLE_TEMPLATES.find((template) => template.key === 'admin')?.permissions).toContain(BRANDING_MANAGE)
    expect(ROLE_TEMPLATES.find((template) => template.key === 'read_only')?.permissions ?? []).not.toContain(BRANDING_MANAGE)
    expect(EVENT_CATALOGUE.definitions.find((definition) => definition.type === 'company_branding.changed')?.live).toMatchObject({ permission: 'documents.view' })
  })

  it('checks the bodies strictly', () => {
    expect(brandingBody.safeParse({ ...EMPTY, version: 1 }).success).toBe(true)
    expect(brandingBody.safeParse({ ...EMPTY, colour: '#000000' }).success).toBe(false)
    expect(logoUploadBody.safeParse({ originalName: 'logo.png', contentType: 'image/png', sizeBytes: 10, sha256: 'a'.repeat(64) }).success).toBe(true)
    expect(logoUploadBody.safeParse({ originalName: 'logo.png', contentType: 'image/png', sizeBytes: 10, sha256: 'A'.repeat(64) }).success).toBe(false)
  })
})

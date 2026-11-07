import { describe, expect, it } from 'vitest'
import { checkBranding } from '@nexus/ui/tokens/branding'
import { senderOf } from '../../shell/links/view/LinkFrameView'
import { brandingTokensOf } from './branding'

/** B-W2b-161: a company's branding as the link frame and the portal's sign-in page draw it. */

const COMPANY = '0190f0e2-6161-7000-8000-000000000001'
const READ = {
  companyId: COMPANY,
  name: 'Portale Demo',
  companyName: 'Officina Demo',
  logoPath: `/branding/public/${COMPANY}/logo/a`,
  logoDarkPath: `/branding/public/${COMPANY}/logo/b`,
  accentColour: '#0b3d91',
}

describe('a branding as the design system\'s tokens', () => {
  it('heads a link with the company\'s name and the portal with its own; logos through /api, a path the DS keeps', () => {
    const link = brandingTokensOf(READ, 'company')
    expect(link).toEqual({ companyId: COMPANY, name: 'Officina Demo', logoUrl: `/api/branding/public/${COMPANY}/logo/a`, logoDarkUrl: `/api/branding/public/${COMPANY}/logo/b`, accent: '#0b3d91' })
    expect(brandingTokensOf(READ, 'portal').name).toBe('Portale Demo')
    expect(checkBranding(link).logoUrl).toBe(link.logoUrl)
  })

  it('an unbranded company: its name in text and the standard colours', () => {
    const plain = brandingTokensOf({ ...READ, logoPath: null, logoDarkPath: null, accentColour: null }, 'company')
    expect(plain).toMatchObject({ logoUrl: null, logoDarkUrl: null, accent: null })
    expect(checkBranding(plain).logoUrl).toBeUndefined()
  })
})

describe('the link frame\'s sender', () => {
  const branding = brandingTokensOf(READ, 'company')
  it('takes what the page gave, each missing field from the branding', () => {
    expect(senderOf(null, null)).toBeNull()
    expect(senderOf(null, branding)).toBe(branding)
    const given = { name: 'Officina Demo S.r.l.', companyId: null, contact: { email: 'ordini@example.com' } }
    expect(senderOf(given, null)).toBe(given)
    expect(senderOf(given, branding)).toEqual({ ...given, name: 'Officina Demo S.r.l.', companyId: COMPANY, logoUrl: branding.logoUrl, logoDarkUrl: branding.logoDarkUrl, accent: '#0b3d91' })
    expect(senderOf({ name: '' }, branding)?.name).toBe('Officina Demo')
  })
})

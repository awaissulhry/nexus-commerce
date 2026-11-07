import { z } from 'zod'
import { brandingBody, brandingView, logoUploadBody, publicBranding } from '@nexus/factory-domain/branding/contracts'
import { LOGO_CONTENT_TYPES } from '@nexus/factory-domain/branding/rules'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../files/contract'

/**
 * The branding routes' contracts (B-W2b-161; the shapes are factory-domain branding/contracts, shared with the web). The
 * public logo answers with the picture itself (image/png or image/jpeg), not JSON.
 */

const company = input({ companyId: id() })

export const getBrandingContract = defineContract({ querystring: company, response: { 200: output({ branding: brandingView }) } })

export const putBrandingContract = defineContract({
  params: company,
  body: brandingBody,
  response: { 200: output({ branding: brandingView, changed: z.array(z.string()) }) },
})

export const announceLogoContract = defineContract({ params: company, body: logoUploadBody, response: { 201: output({ file: fileView, upload: presignedView }) } })

export const completeLogoContract = defineContract({
  params: input({ companyId: id(), fileId: id() }),
  response: { 200: output({ file: fileView, logo: output({ fileId: id(), contentType: z.enum(LOGO_CONTENT_TYPES) }) }) },
})

export const publicBrandingContract = defineContract({ params: company, response: { 200: output({ branding: publicBranding }) } })

export const publicLogoContract = defineContract({ params: input({ companyId: id(), fileId: id() }), response: {} })

export const linkBrandingContract = defineContract({ response: { 200: output({ branding: publicBranding }) } })

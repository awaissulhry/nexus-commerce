import { z } from 'zod'

export const shopifyFileTypeSchema = z.enum(['all', 'image', 'video', 'document', 'model3d'])
export type ShopifyFileType = z.infer<typeof shopifyFileTypeSchema>
export const shopifyFileIdSchema = z.string().regex(/^gid:\/\/shopify\/(MediaImage|Video|GenericFile|Model3d)\/\d+$/)
export const shopifyFileQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(200),
  type: shopifyFileTypeSchema.default('all'),
  search: z.string().trim().max(200).default(''),
  after: z.string().max(2000).optional(),
}).strict()

export interface ShopifyMediaSource {
  accountId: string
  label: string
  domain: string | null
  isPrimary: boolean
  readIssue: string | null
  uploadIssue: string | null
}
export interface MediaSourcesResponse {
  stores: ShopifyMediaSource[]
  /** null means several stores need an explicit choice. */
  defaultSource: string | null
}
export interface ShopifyFile {
  id: string
  accountId: string
  type: Exclude<ShopifyFileType, 'all'>
  label: string
  alt: string | null
  status: string
  errors: string[]
  url: string | null
  previewUrl: string | null
  mimeType: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  durationSeconds: number | null
  createdAt: string
  updatedAt: string
}
export interface ShopifyFilesResponse {
  accountId: string
  items: ShopifyFile[]
  nextCursor: string | null
  fetchedAt: string
}
export interface ShopifyFileReference { assetId: string; url: string; label: string }

export const SHOPIFY_UPLOAD_MAX_BYTES = 200 * 1024 * 1024
export const SHOPIFY_UPLOAD_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.avif,.heic,.mp4,.mov,.webm,.glb,.usdz,.pdf,.txt,.csv,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx'

import { z } from 'zod'
export const informationTranslationSchema = z.object({ resourceId: z.string().regex(/^gid:\/\/shopify\/(Product|Metafield)\/\d+$/),
  fieldId: z.string().min(1).max(1000), key: z.string().min(1).max(255), locale: z.string().min(2).max(35), digest: z.string().min(1).max(1000),
}).strict()
export type InformationTranslation = z.infer<typeof informationTranslationSchema>
export interface InformationTranslationValue extends InformationTranslation { value: string | null; sourceValue: string | null; outdated: boolean }
/** These are Shopify's API property names, independent of translated display labels. */
export const nativeTranslationKeys: Record<string, string> = { title: 'title', descriptionHtml: 'body_html', handle: 'handle', productType: 'product_type', 'seo.title': 'meta_title', 'seo.description': 'meta_description' }

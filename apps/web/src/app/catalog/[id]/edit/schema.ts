import { z } from 'zod'

const forbiddenWords = ['free', 'discount', 'cheap', 'sale', 'clearance']

const forbiddenWordCheck = (val: string) => {
  const lower = val.toLowerCase()
  return !forbiddenWords.some((word) => lower.includes(word))
}

// ── Variation theme presets (Rithum pattern) ────────────────────────────
export const VARIATION_THEMES = [
  { value: 'Size', label: 'Size', axes: ['Size'] },
  { value: 'Color', label: 'Color', axes: ['Color'] },
  { value: 'SizeColor', label: 'Size + Color', axes: ['Size', 'Color'] },
  { value: 'SizeMaterial', label: 'Size + Material', axes: ['Size', 'Material'] },
  { value: 'ColorMaterial', label: 'Color + Material', axes: ['Color', 'Material'] },
  { value: 'SizeColorMaterial', label: 'Size + Color + Material', axes: ['Size', 'Color', 'Material'] },
  { value: 'Style', label: 'Style', axes: ['Style'] },
  { value: 'Pattern', label: 'Pattern', axes: ['Pattern'] },
] as const

export type VariationThemeValue = (typeof VARIATION_THEMES)[number]['value']

// Helper to get axes for a given theme
export function getAxesForTheme(theme: string): string[] {
  const found = VARIATION_THEMES.find((t) => t.value === theme)
  return found ? [...found.axes] : [theme] // fallback: treat theme name as single axis
}

// ── Variation schema (Rithum-level per-variant data) ────────────────────
const variationSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),

  // Multi-axis variation attributes (Rithum pattern)
  // e.g., { "Color": "Black", "Size": "10" }
  variationAttributes: z.record(z.string(), z.string()).optional().default({}),

  // Legacy single-axis fields (backward compat)
  name: z.string().optional(),
  value: z.string().optional(),

  // Pricing
  price: z.coerce.number().min(0.01, 'Price must be greater than 0'),
  costPrice: z.coerce.number().min(0).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  mapPrice: z.coerce.number().min(0).optional(),

  // Inventory
  stock: z.coerce.number().int().min(0, 'Stock cannot be negative'),

  // Per-variant identifiers
  upc: z
    .string()
    .optional()
    .refine((val) => !val || /^\d{12}$/.test(val), {
      message: 'UPC must be exactly 12 digits',
    }),
  ean: z
    .string()
    .optional()
    .refine((val) => !val || /^\d{13}$/.test(val), {
      message: 'EAN must be exactly 13 digits',
    }),
  gtin: z.string().optional(),

  // Per-variant physical attributes
  weightValue: z.coerce.number().min(0).optional(),
  weightUnit: z.string().optional(),
  dimLength: z.coerce.number().min(0).optional(),
  dimWidth: z.coerce.number().min(0).optional(),
  dimHeight: z.coerce.number().min(0).optional(),
  dimUnit: z.string().optional(),

  // Per-variant fulfillment
  fulfillmentMethod: z.enum(['FBA', 'FBM']).nullable().optional(),

  // Per-variant marketplace IDs (read-only, populated by sync)
  amazonAsin: z.string().optional(),
  ebayVariationId: z.string().optional(),

  // Status
  isActive: z.boolean().optional().default(true),
})

export type VariationFormData = z.infer<typeof variationSchema>

export const productEditorSchema = z.object({
  // Tab 1: Vital Info
  name: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be 200 characters or less')
    .refine(forbiddenWordCheck, {
      message: `Title cannot contain: ${forbiddenWords.join(', ')}`,
    }),
  brand: z.string().optional(),
  manufacturer: z.string().optional(),
  upc: z
    .string()
    .optional()
    .refine((val) => !val || /^\d{12}$/.test(val), {
      message: 'UPC must be exactly 12 digits',
    }),
  ean: z
    .string()
    .optional()
    .refine((val) => !val || /^\d{13}$/.test(val), {
      message: 'EAN must be exactly 13 digits',
    }),
  categoryBreadcrumbs: z.string().optional(),
  categoryAttributes: z.record(z.string(), z.any()).optional().default({}),

  // Tab 2: Offer
  basePrice: z.coerce.number().min(0.01, 'Price must be greater than 0'),
  salePrice: z.coerce.number().min(0).optional(),
  totalStock: z.coerce.number().int().min(0, 'Stock cannot be negative'),
  fulfillmentMethod: z.enum(['FBA', 'FBM']).nullable().optional(),

  // Tab 3: Images
  images: z
    .array(
      z.object({
        url: z.string().url('Must be a valid URL'),
        alt: z.string().optional(),
        type: z.enum(['MAIN', 'ALT', 'LIFESTYLE']),
      })
    )
    .optional()
    .default([]),

  // Tab 4: Description
  bulletPoints: z
    .array(z.string().max(500, 'Each bullet point must be 500 chars or less'))
    .max(5, 'Maximum 5 bullet points')
    .optional()
    .default([]),
  aPlusContent: z.string().optional(),

  // Tab 5: Variations (Rithum-level)
  variationTheme: z.string().nullable().optional(), // e.g., "SizeColor", null for standalone
  variations: z.array(variationSchema).optional().default([]),

  // Physical attributes (parent-level defaults)
  weightValue: z.coerce.number().min(0).optional(),
  weightUnit: z.string().optional(),
  dimLength: z.coerce.number().min(0).optional(),
  dimWidth: z.coerce.number().min(0).optional(),
  dimHeight: z.coerce.number().min(0).optional(),
  dimUnit: z.string().optional(),

  // Product status
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
})

export type ProductEditorFormData = z.infer<typeof productEditorSchema>

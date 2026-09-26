/**
 * NCF — a synthetic Shopify product CSV in the shape measured on the Owner's export (study §7): the classic header
 * names in Shopify's order, comma, LF, UTF-8 without BOM, prices with two decimals, grams with one. Every value is
 * invented (ACME); the store's own metafields are replaced by two generic ones.
 */
export const SHOPIFY_CLASSIC_HEADERS = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option1 Linked To', 'Option2 Name', 'Option2 Value', 'Option2 Linked To', 'Option3 Name', 'Option3 Value', 'Option3 Linked To',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price',
  'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Unit Price Total Measure', 'Unit Price Total Measure Unit', 'Unit Price Base Measure',
  'Unit Price Base Measure Unit', 'Variant Barcodes', 'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description',
  'Google Shopping / Google Product Category', 'Google Shopping / Gender', 'Google Shopping / Condition',
  'Concise description (product.metafields.custom.concise_description)', 'Features (product.metafields.custom.features)',
  'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item', 'Status']

/** The same columns under the help page's newer names (study §2.1, S4), where Shopify renamed them. */
export const SHOPIFY_CURRENT_HEADERS = SHOPIFY_CLASSIC_HEADERS.map(h => ({
  Handle: 'URL handle', 'Body (HTML)': 'Description', 'Product Category': 'Product category', Published: 'Published on online store', 'Variant SKU': 'SKU',
  'Variant Grams': 'Weight value (grams)', 'Variant Inventory Tracker': 'Inventory tracker', 'Variant Inventory Qty': 'Inventory quantity',
  'Variant Inventory Policy': 'Continue selling when out of stock', 'Variant Fulfillment Service': 'Fulfillment service', 'Variant Price': 'Price',
  'Variant Compare At Price': 'Compare-at price', 'Variant Requires Shipping': 'Requires shipping', 'Variant Taxable': 'Charge tax', 'Variant Barcodes': 'Barcode',
  'Image Src': 'Product image URL', 'Image Position': 'Image position', 'Image Alt Text': 'Image alt text', 'Gift Card': 'Gift card', 'SEO Title': 'SEO title',
  'SEO Description': 'SEO description', 'Variant Image': 'Variant image URL', 'Variant Weight Unit': 'Weight unit for display', 'Variant Tax Code': 'Tax code',
} as Record<string, string>)[h] ?? h)

/** Shopify's inventory export (quantities by location). */
export const SHOPIFY_INVENTORY_HEADERS = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'SKU', 'HS Code', 'COO',
  'Location', 'Bin name', 'Incoming (not editable)', 'Unavailable (not editable)', 'Committed (not editable)', 'Available (not editable)', 'On hand (current)', 'On hand (new)']

const cell = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
export function csvOf(headers: readonly string[], rows: readonly Record<string, string>[], options: { eol?: string; bom?: boolean; delimiter?: string } = {}): Buffer {
  const eol = options.eol ?? '\n', d = options.delimiter ?? ','
  const line = (values: string[]) => values.map(v => d === ',' ? cell(v) : /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(d)
  const text = [line([...headers]), ...rows.map(r => line(headers.map(h => r[h] ?? '')))].join(eol) + eol
  return Buffer.from((options.bom ? '﻿' : '') + text, 'utf8')
}

/** Shopify's product rows: the first row of a handle carries the product fields; later rows only the variant; a picture row only the handle and picture. */
const product = { Vendor: 'ACME', 'Product Category': 'Apparel & Accessories > Clothing', Type: 'Jacket', Published: 'true', 'Gift Card': 'false', Status: 'active',
  'Google Shopping / Gender': 'unisex', 'Google Shopping / Condition': 'new' }
const variant = { 'Variant Inventory Tracker': 'shopify', 'Variant Inventory Qty': '7', 'Variant Inventory Policy': 'deny', 'Variant Fulfillment Service': 'manual',
  'Variant Requires Shipping': 'true', 'Variant Taxable': 'true', 'Variant Barcodes': '', 'Variant Weight Unit': 'kg', 'Variant Grams': '1200.0' }
export const SHOPIFY_SAMPLE_ROWS: Record<string, string>[] = [
  { Handle: 'acme-jacket', Title: 'Acme jacket', 'Body (HTML)': '<p>A warm jacket,\nwith "two" pockets.</p>', Tags: 'Jackets, Winter, Acme', ...product,
    'Option1 Name': 'Size', 'Option1 Value': 'S', 'Variant SKU': 'ACME-JACKET-S', ...variant, 'Variant Price': '199.00', 'Variant Compare At Price': '249.00',
    'Image Src': 'https://cdn.example.test/acme/jacket-1.jpg', 'Image Position': '1', 'SEO Title': 'Acme jacket | ACME', 'SEO Description': 'The Acme jacket.',
    'Concise description (product.metafields.custom.concise_description)': 'Warm', 'Features (product.metafields.custom.features)': 'Waterproof; Breathable', 'Cost per item': '80.00' },
  { Handle: 'acme-jacket', 'Option1 Value': 'M', 'Variant SKU': 'ACME-JACKET-M', ...variant, 'Variant Price': '199.00', 'Variant Compare At Price': '249.00', 'Variant Barcodes': '4006381333931',
    'Image Src': 'https://cdn.example.test/acme/jacket-2.jpg', 'Image Position': '2' },
  { Handle: 'acme-jacket', 'Option1 Value': 'L', 'Variant SKU': 'ACME-JACKET-L', ...variant, 'Variant Price': '209.00', 'Variant Grams': '1300.0' },
  { Handle: 'acme-jacket', 'Image Src': 'https://cdn.example.test/acme/jacket-3.jpg', 'Image Position': '3' },
  { Handle: 'acme-cap', Title: 'Acme cap', 'Body (HTML)': '', Tags: 'Caps', ...product, Type: 'Cap', Status: 'draft', Published: 'false',
    'Option1 Name': 'Title', 'Option1 Value': 'Default Title', 'Variant SKU': 'ACME-CAP', ...variant, 'Variant Price': '25.00', 'Variant Grams': '0.0', 'Variant Weight Unit': 'g' },
  { Handle: 'acme-gloves', Title: 'Acme gloves', Tags: 'Gloves', ...product, Type: 'Gloves', 'Option1 Name': 'Size', 'Option1 Value': 'M', ...variant, 'Variant Price': '39.00' },
  { Handle: 'acme-gloves', 'Option1 Value': 'L', ...variant, 'Variant Price': '39.00' },
]

export const shopifySampleCsv = (options?: Parameters<typeof csvOf>[2]) => csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS, options)

/**
 * P2.2 — Human-readable titles and actionable hints for common Amazon
 * SP-API feed error codes. Codes that are already self-explanatory via
 * their message text are omitted.
 */
export interface FeedErrorInfo { title: string; hint: string }

export const FEED_ERROR_CODES: Record<string, FeedErrorInfo> = {
  // Required / missing fields
  '90220': { title: 'Required field missing', hint: 'Fill in this field and resubmit.' },
  '90221': { title: 'Conditionally required', hint: 'This field is required for this product type.' },
  '8009':  { title: 'Missing value', hint: 'The value is required — fill in before pushing.' },

  // Value / format errors
  '5461':  { title: 'Invalid value', hint: 'Select a value from the allowed list.' },
  '8058':  { title: 'Data type mismatch', hint: 'Value format does not match the expected type (e.g. text where a number is expected).' },
  '8560':  { title: 'Category validation', hint: 'Product type may not match the selected browse node.' },
  '8562':  { title: 'Invalid attribute value', hint: 'The value is not in the schema for this product type.' },

  // Listing / ASIN errors
  '8541':  { title: 'Brand mismatch', hint: 'Brand name must match Amazon Brand Registry exactly.' },
  '8568':  { title: 'Variation theme mismatch', hint: 'Parent/child variation themes must match.' },
  '8572':  { title: 'Variation invalid', hint: 'Child SKU references a parent that does not exist or has a different variation theme.' },
  '8000':  { title: 'SKU not found', hint: 'This SKU does not exist on this marketplace — use item_type: "update" if the ASIN already exists.' },
  '90235': { title: 'Duplicate ASIN', hint: 'This SKU already maps to an existing ASIN.' },

  // Image errors
  '5000':  { title: 'Image issue', hint: 'Check image dimensions (min 500 × 500 px) and format (JPEG or PNG, RGB, no watermark).' },
  '5004':  { title: 'Image too small', hint: 'Minimum 500 × 500 px on the longest side; 1000 × 1000 px recommended.' },
  '5005':  { title: 'Image fetch failed', hint: 'Amazon could not download the image URL. Check it is publicly reachable.' },

  // System / feed errors
  '6023':  { title: 'Feed timeout', hint: 'Amazon\'s processing timed out — resubmit.' },
  '99003': { title: 'Internal error', hint: 'Amazon-side error — wait a few minutes and resubmit.' },
}

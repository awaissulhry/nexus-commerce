/**
 * Which listing keys are TEXT content (title, description, bullets, keywords) and so belong to the content tools, not
 * to set-listing-fields. The WHOLE key must name the text field (an optional `attr_` and channel prefix, an optional slot
 * number): an attribute that merely ends in `_description` — Amazon `age_range_description`, `item_length_description` —
 * is an attribute (2026-10-02: the old `(^|_)description(_|$)` match refused Amazon's required Age Range).
 */
const CONTENT_KEY = /^(attr_)?((amazon|ebay|shopify|etsy)_)?(title|description|product_description|item_name|bullets?|bullet_points?|bulletPoints|generic_keywords?|keywords?|search_terms|tags)(_\d+)?$/i

export const isListingContentKey = (key: string) => CONTENT_KEY.test(key)

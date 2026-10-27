/**
 * eBay's AI topics (REST getFeedback `filter=topics:<topic>`, the values eBay's reference lists:
 * https://developer.ebay.com/api-docs/commerce/feedback/resources/feedback/methods/getFeedback) and their words. Pure, no
 * imports, so list and page services read the words without loading the eBay adapters.
 */
/** eBay's AI topics (the `topics:` filter values of getFeedback). */
export const EBAY_FEEDBACK_TOPICS = [
  'shipping', 'service', 'packaging', 'description', 'seller-satisfaction', 'overall-satisfaction', 'refund', 'inventory',
  'customer loyalty', 'seller-other', 'quality', 'price', 'condition', 'fit', 'appearance', 'dimensions', 'usage',
  'product-satisfaction', 'product-other', 'extras',
] as const
/** eBay's topics in words. */
export const EBAY_TOPIC_WORDS: Record<string, string> = {
  shipping: 'Shipping', service: 'Service', packaging: 'Packaging', description: 'Matches the description',
  'seller-satisfaction': 'Happy with the seller', 'overall-satisfaction': 'Overall', refund: 'Refund', inventory: 'Stock',
  'customer loyalty': 'Buys again', 'seller-other': 'Seller, other', quality: 'Quality', price: 'Price', condition: 'Condition',
  fit: 'Fit & sizing', appearance: 'Looks', dimensions: 'Size & dimensions', usage: 'Use', 'product-satisfaction': 'Happy with the item',
  'product-other': 'Item, other', extras: 'Extras',
}

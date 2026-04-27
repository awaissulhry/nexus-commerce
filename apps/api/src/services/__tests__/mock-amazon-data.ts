/**
 * Mock Amazon product data for testing the sync service
 */

export const mockAmazonProducts = [
  // Parent product with variations
  {
    asin: "B0A1B2C3D4",
    title: "Premium Wireless Headphones",
    sku: "HEADPHONES-PREMIUM-001",
    price: 199.99,
    stock: 150,
    fulfillmentChannel: "FBA",
    shippingTemplate: "STANDARD",
    variations: [
      {
        asin: "B0A1B2C3D5",
        title: "Premium Wireless Headphones - Black",
        sku: "HEADPHONES-PREMIUM-BLACK",
        price: 199.99,
        stock: 50,
      },
      {
        asin: "B0A1B2C3D6",
        title: "Premium Wireless Headphones - Silver",
        sku: "HEADPHONES-PREMIUM-SILVER",
        price: 199.99,
        stock: 50,
      },
      {
        asin: "B0A1B2C3D7",
        title: "Premium Wireless Headphones - Gold",
        sku: "HEADPHONES-PREMIUM-GOLD",
        price: 199.99,
        stock: 50,
      },
    ],
  },

  // Another parent product with variations
  {
    asin: "B0B1B2C3D4",
    title: "Smart Watch Pro",
    sku: "SMARTWATCH-PRO-001",
    price: 299.99,
    stock: 200,
    fulfillmentChannel: "FBA",
    shippingTemplate: "STANDARD",
    variations: [
      {
        asin: "B0B1B2C3D5",
        title: "Smart Watch Pro - 40mm",
        sku: "SMARTWATCH-PRO-40MM",
        price: 299.99,
        stock: 100,
      },
      {
        asin: "B0B1B2C3D6",
        title: "Smart Watch Pro - 44mm",
        sku: "SMARTWATCH-PRO-44MM",
        price: 329.99,
        stock: 100,
      },
    ],
  },

  // Standalone product (no variations)
  {
    asin: "B0C1B2C3D4",
    title: "USB-C Cable 6ft",
    sku: "CABLE-USBC-6FT",
    price: 12.99,
    stock: 500,
    fulfillmentChannel: "FBA",
    shippingTemplate: "STANDARD",
  },

  // Another standalone product
  {
    asin: "B0D1B2C3D4",
    title: "Phone Screen Protector",
    sku: "PROTECTOR-SCREEN-001",
    price: 9.99,
    stock: 1000,
    fulfillmentChannel: "FBM",
    shippingTemplate: "EXPEDITED",
  },

  // Parent product with many variations
  {
    asin: "B0E1B2C3D4",
    title: "Phone Case Universal",
    sku: "CASE-UNIVERSAL-001",
    price: 19.99,
    stock: 500,
    fulfillmentChannel: "FBA",
    shippingTemplate: "STANDARD",
    variations: [
      {
        asin: "B0E1B2C3D5",
        title: "Phone Case Universal - Red",
        sku: "CASE-UNIVERSAL-RED",
        price: 19.99,
        stock: 100,
      },
      {
        asin: "B0E1B2C3D6",
        title: "Phone Case Universal - Blue",
        sku: "CASE-UNIVERSAL-BLUE",
        price: 19.99,
        stock: 100,
      },
      {
        asin: "B0E1B2C3D7",
        title: "Phone Case Universal - Black",
        sku: "CASE-UNIVERSAL-BLACK",
        price: 19.99,
        stock: 100,
      },
      {
        asin: "B0E1B2C3D8",
        title: "Phone Case Universal - White",
        sku: "CASE-UNIVERSAL-WHITE",
        price: 19.99,
        stock: 100,
      },
      {
        asin: "B0E1B2C3D9",
        title: "Phone Case Universal - Green",
        sku: "CASE-UNIVERSAL-GREEN",
        price: 19.99,
        stock: 100,
      },
    ],
  },
];

/**
 * Expected sync results for mock data
 */
export const expectedSyncResults = {
  totalProducts: 11, // 5 parents + 1 standalone + 5 children
  parentCount: 5,
  childCount: 5,
  standaloneCount: 1,
  totalProcessed: 11,
  parentsCreated: 5,
  childrenCreated: 5,
  errors: 0,
};

/**
 * Invalid product data for testing error handling
 */
export const invalidProducts = [
  {
    // Missing ASIN
    title: "Invalid Product 1",
    sku: "INVALID-001",
  },
  {
    // Missing SKU
    asin: "B0F1B2C3D4",
    title: "Invalid Product 2",
  },
  {
    // Missing title
    asin: "B0G1B2C3D4",
    sku: "INVALID-003",
  },
  {
    // All fields missing
  },
];

/**
 * Products with edge cases for testing
 */
export const edgeCaseProducts = [
  {
    // Very long title
    asin: "B0H1B2C3D4",
    title:
      "This is a very long product title that contains many words and characters to test how the system handles extremely long product names that might exceed normal database field lengths",
    sku: "EDGE-LONG-TITLE",
    price: 99.99,
    stock: 100,
  },
  {
    // Very high price
    asin: "B0I1B2C3D4",
    title: "Premium Luxury Item",
    sku: "EDGE-HIGH-PRICE",
    price: 99999.99,
    stock: 1,
  },
  {
    // Zero stock
    asin: "B0J1B2C3D4",
    title: "Out of Stock Item",
    sku: "EDGE-ZERO-STOCK",
    price: 49.99,
    stock: 0,
  },
  {
    // Special characters in SKU
    asin: "B0K1B2C3D4",
    title: "Special Characters Product",
    sku: "EDGE-SPECIAL-!@#$%",
    price: 29.99,
    stock: 50,
  },
  {
    // Duplicate ASIN (should be handled)
    asin: "B0A1B2C3D4", // Same as first product
    title: "Duplicate ASIN Product",
    sku: "EDGE-DUPLICATE-ASIN",
    price: 39.99,
    stock: 75,
  },
];

/**
 * Large dataset for performance testing
 */
export function generateLargeDataset(count: number = 1000) {
  const products = [];

  for (let i = 0; i < count; i++) {
    const isParent = Math.random() > 0.7; // 30% chance of being parent

    if (isParent) {
      const variationCount = Math.floor(Math.random() * 5) + 2; // 2-6 variations
      const variations = [];

      for (let j = 0; j < variationCount; j++) {
        variations.push({
          asin: `B${String(i).padStart(10, "0")}V${j}`,
          title: `Product ${i} - Variation ${j}`,
          sku: `PERF-TEST-${i}-VAR-${j}`,
          price: Math.random() * 500 + 10,
          stock: Math.floor(Math.random() * 1000),
        });
      }

      products.push({
        asin: `B${String(i).padStart(10, "0")}`,
        title: `Performance Test Product ${i}`,
        sku: `PERF-TEST-${i}`,
        price: Math.random() * 500 + 10,
        stock: Math.floor(Math.random() * 1000),
        fulfillmentChannel: Math.random() > 0.5 ? "FBA" : "FBM",
        shippingTemplate: Math.random() > 0.5 ? "STANDARD" : "EXPEDITED",
        variations,
      });
    } else {
      products.push({
        asin: `B${String(i).padStart(10, "0")}`,
        title: `Performance Test Product ${i}`,
        sku: `PERF-TEST-${i}`,
        price: Math.random() * 500 + 10,
        stock: Math.floor(Math.random() * 1000),
        fulfillmentChannel: Math.random() > 0.5 ? "FBA" : "FBM",
        shippingTemplate: Math.random() > 0.5 ? "STANDARD" : "EXPEDITED",
      });
    }
  }

  return products;
}

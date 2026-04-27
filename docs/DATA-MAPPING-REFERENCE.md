# Data Mapping Reference

**Version**: 1.0.0  
**Last Updated**: 2026-04-23

---

## Table of Contents

1. [Product Mapping](#product-mapping)
2. [Variant Mapping](#variant-mapping)
3. [Inventory Mapping](#inventory-mapping)
4. [Price Mapping](#price-mapping)
5. [Order Mapping](#order-mapping)
6. [Image Mapping](#image-mapping)
7. [Attribute Mapping](#attribute-mapping)
8. [Custom Field Mapping](#custom-field-mapping)

---

## Product Mapping

### Core Product Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `id` | `id` | `id` | `listing_id` | Unique identifier |
| `title` | `title` | `name` | `title` | Product name |
| `description` | `body_html` | `description` | `description` | Full description |
| `shortDescription` | N/A | `short_description` | N/A | Short description |
| `sku` | `variants[0].sku` | `sku` | `sku` | Stock keeping unit |
| `vendor` | `vendor` | N/A | N/A | Manufacturer/brand |
| `productType` | `product_type` | `type` | `category_id` | Product category |
| `status` | `status` | `status` | `state` | Publication status |
| `createdAt` | `created_at` | `date_created` | `creation_tsz` | Creation timestamp |
| `updatedAt` | `updated_at` | `date_modified` | `last_modified_tsz` | Last update timestamp |
| `publishedAt` | `published_at` | N/A | N/A | Publication timestamp |

### Status Mapping

| Nexus Status | Shopify | WooCommerce | Etsy |
|--------------|---------|-------------|------|
| `DRAFT` | `draft` | `draft` | `inactive` |
| `ACTIVE` | `active` | `publish` | `active` |
| `INACTIVE` | `archived` | `private` | `deactivated` |
| `DELETED` | N/A | `trash` | `deleted` |

### Example Product Mapping

```typescript
// Shopify → Nexus
const nexusProduct = {
  id: shopifyProduct.id,
  title: shopifyProduct.title,
  description: shopifyProduct.body_html,
  sku: shopifyProduct.variants[0]?.sku,
  vendor: shopifyProduct.vendor,
  productType: shopifyProduct.product_type,
  status: shopifyProduct.status === 'active' ? 'ACTIVE' : 'DRAFT',
  createdAt: new Date(shopifyProduct.created_at),
  updatedAt: new Date(shopifyProduct.updated_at),
  channel: 'SHOPIFY',
  channelProductId: shopifyProduct.id,
};

// WooCommerce → Nexus
const nexusProduct = {
  id: wooProduct.id,
  title: wooProduct.name,
  description: wooProduct.description,
  shortDescription: wooProduct.short_description,
  sku: wooProduct.sku,
  vendor: wooProduct.manufacturer || 'Unknown',
  productType: wooProduct.type,
  status: wooProduct.status === 'publish' ? 'ACTIVE' : 'DRAFT',
  createdAt: new Date(wooProduct.date_created),
  updatedAt: new Date(wooProduct.date_modified),
  channel: 'WOOCOMMERCE',
  channelProductId: wooProduct.id,
};

// Etsy → Nexus
const nexusProduct = {
  id: etsyListing.listing_id,
  title: etsyListing.title,
  description: etsyListing.description,
  sku: etsyListing.sku,
  vendor: 'Etsy Shop',
  productType: etsyListing.category_id,
  status: etsyListing.state === 'active' ? 'ACTIVE' : 'INACTIVE',
  createdAt: new Date(etsyListing.creation_tsz * 1000),
  updatedAt: new Date(etsyListing.last_modified_tsz * 1000),
  channel: 'ETSY',
  channelProductId: etsyListing.listing_id,
};
```

---

## Variant Mapping

### Core Variant Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `id` | `id` | `id` | `product_id` | Variant identifier |
| `productId` | `product_id` | `product_id` | `listing_id` | Parent product ID |
| `title` | `title` | `name` | `property_values` | Variant name/title |
| `sku` | `sku` | `sku` | `sku` | Stock keeping unit |
| `price` | `price` | `price` | `price` | Current price |
| `regularPrice` | `price` | `regular_price` | `price` | Regular price |
| `salePrice` | `compare_at_price` | `sale_price` | N/A | Sale price |
| `quantity` | `inventory_quantity` | `stock_quantity` | `quantity` | Stock quantity |
| `weight` | `weight` | `weight` | `item_weight` | Weight |
| `weightUnit` | `weight_unit` | `weight_unit` | `weight_unit` | Weight unit |
| `barcode` | `barcode` | `ean` | N/A | Barcode/EAN |

### Example Variant Mapping

```typescript
// Shopify → Nexus
const nexusVariant = {
  id: shopifyVariant.id,
  productId: shopifyVariant.product_id,
  title: shopifyVariant.title,
  sku: shopifyVariant.sku,
  price: parseFloat(shopifyVariant.price),
  regularPrice: parseFloat(shopifyVariant.price),
  salePrice: shopifyVariant.compare_at_price ? parseFloat(shopifyVariant.compare_at_price) : null,
  quantity: shopifyVariant.inventory_quantity,
  weight: shopifyVariant.weight,
  weightUnit: shopifyVariant.weight_unit,
  barcode: shopifyVariant.barcode,
  channel: 'SHOPIFY',
  channelVariantId: shopifyVariant.id,
};

// WooCommerce → Nexus
const nexusVariant = {
  id: wooVariation.id,
  productId: wooVariation.product_id,
  title: wooVariation.attributes.map(a => a.option).join(' - '),
  sku: wooVariation.sku,
  price: parseFloat(wooVariation.price),
  regularPrice: parseFloat(wooVariation.regular_price),
  salePrice: wooVariation.sale_price ? parseFloat(wooVariation.sale_price) : null,
  quantity: wooVariation.stock_quantity,
  weight: wooVariation.weight,
  weightUnit: 'kg',
  barcode: wooVariation.ean,
  channel: 'WOOCOMMERCE',
  channelVariantId: wooVariation.id,
  channelProductId: wooVariation.product_id,
};

// Etsy → Nexus
const nexusVariant = {
  id: etsyProduct.product_id,
  productId: etsyListing.listing_id,
  title: etsyProduct.property_values.map(p => p.values[0]).join(' - '),
  sku: etsyProduct.sku,
  price: parseFloat(etsyOffering.price),
  regularPrice: parseFloat(etsyOffering.price),
  salePrice: null,
  quantity: etsyOffering.quantity,
  weight: etsyListing.item_weight,
  weightUnit: etsyListing.weight_unit,
  barcode: null,
  channel: 'ETSY',
  channelVariantId: etsyProduct.product_id,
  channelProductId: etsyListing.listing_id,
};
```

---

## Inventory Mapping

### Inventory Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `variantId` | `inventory_item_id` | `variation_id` | `product_id` | Variant reference |
| `quantity` | `available` | `stock_quantity` | `quantity` | Available quantity |
| `reserved` | N/A | N/A | N/A | Reserved quantity |
| `available` | `available` | `stock_quantity` | `quantity` | Available for sale |
| `status` | `status` | `stock_status` | N/A | Stock status |
| `lastUpdated` | `updated_at` | `date_modified` | `last_modified_tsz` | Last update |

### Stock Status Mapping

| Nexus Status | Shopify | WooCommerce | Etsy |
|--------------|---------|-------------|------|
| `IN_STOCK` | `active` | `instock` | `active` |
| `OUT_OF_STOCK` | `inactive` | `outofstock` | `inactive` |
| `BACKORDER` | N/A | `onbackorder` | N/A |

### Example Inventory Mapping

```typescript
// Shopify → Nexus
const nexusInventory = {
  variantId: shopifyInventory.inventory_item_id,
  quantity: shopifyInventory.available,
  reserved: 0,
  available: shopifyInventory.available,
  status: shopifyInventory.available > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
  lastUpdated: new Date(shopifyInventory.updated_at),
  channel: 'SHOPIFY',
};

// WooCommerce → Nexus
const nexusInventory = {
  variantId: wooVariation.id,
  quantity: wooVariation.stock_quantity,
  reserved: 0,
  available: wooVariation.stock_quantity,
  status: wooVariation.stock_status === 'instock' ? 'IN_STOCK' : 'OUT_OF_STOCK',
  lastUpdated: new Date(wooVariation.date_modified),
  channel: 'WOOCOMMERCE',
};

// Etsy → Nexus
const nexusInventory = {
  variantId: etsyProduct.product_id,
  quantity: etsyOffering.quantity,
  reserved: 0,
  available: etsyOffering.quantity,
  status: etsyOffering.quantity > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
  lastUpdated: new Date(etsyListing.last_modified_tsz * 1000),
  channel: 'ETSY',
};
```

---

## Price Mapping

### Price Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `price` | `price` | `price` | `price` | Current selling price |
| `regularPrice` | `price` | `regular_price` | `price` | Regular/list price |
| `salePrice` | `compare_at_price` | `sale_price` | N/A | Discounted price |
| `cost` | N/A | `cost` | N/A | Cost of goods |
| `currency` | `currency` | `currency` | `currency_code` | Currency code |
| `taxable` | `taxable` | `tax_status` | `non_taxable` | Tax applicability |

### Currency Mapping

| Nexus | Shopify | WooCommerce | Etsy |
|-------|---------|-------------|------|
| `USD` | `USD` | `USD` | `USD` |
| `EUR` | `EUR` | `EUR` | `EUR` |
| `GBP` | `GBP` | `GBP` | `GBP` |
| `JPY` | `JPY` | `JPY` | `JPY` |
| `CAD` | `CAD` | `CAD` | `CAD` |

### Example Price Mapping

```typescript
// Shopify → Nexus
const nexusPrice = {
  price: parseFloat(shopifyVariant.price),
  regularPrice: parseFloat(shopifyVariant.price),
  salePrice: shopifyVariant.compare_at_price ? parseFloat(shopifyVariant.compare_at_price) : null,
  cost: null,
  currency: 'USD',
  taxable: shopifyVariant.taxable,
  channel: 'SHOPIFY',
};

// WooCommerce → Nexus
const nexusPrice = {
  price: parseFloat(wooVariation.price),
  regularPrice: parseFloat(wooVariation.regular_price),
  salePrice: wooVariation.sale_price ? parseFloat(wooVariation.sale_price) : null,
  cost: wooVariation.cost ? parseFloat(wooVariation.cost) : null,
  currency: 'USD',
  taxable: wooVariation.tax_status === 'taxable',
  channel: 'WOOCOMMERCE',
};

// Etsy → Nexus
const nexusPrice = {
  price: parseFloat(etsyOffering.price),
  regularPrice: parseFloat(etsyOffering.price),
  salePrice: null,
  cost: null,
  currency: etsyListing.currency_code,
  taxable: !etsyListing.non_taxable,
  channel: 'ETSY',
};
```

---

## Order Mapping

### Order Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `id` | `id` | `id` | `order_id` | Order identifier |
| `orderNumber` | `number` | `number` | `order_id` | Order number |
| `status` | `financial_status` | `status` | `status` | Order status |
| `totalPrice` | `total_price` | `total` | `total_price` | Total amount |
| `totalTax` | `total_tax` | `total_tax` | `total_tax_cost` | Tax amount |
| `totalShipping` | `total_shipping_cost` | `shipping_total` | `total_shipping_cost` | Shipping cost |
| `currency` | `currency` | `currency` | `currency_code` | Currency |
| `createdAt` | `created_at` | `date_created` | `creation_tsz` | Creation date |
| `updatedAt` | `updated_at` | `date_modified` | `last_modified_tsz` | Update date |

### Order Status Mapping

| Nexus Status | Shopify | WooCommerce | Etsy |
|--------------|---------|-------------|------|
| `PENDING` | `pending` | `pending` | `pending` |
| `PROCESSING` | `authorized` | `processing` | `processing` |
| `COMPLETED` | `paid` | `completed` | `completed` |
| `CANCELLED` | `cancelled` | `cancelled` | `cancelled` |
| `REFUNDED` | `refunded` | `refunded` | `refunded` |

### Example Order Mapping

```typescript
// Shopify → Nexus
const nexusOrder = {
  id: shopifyOrder.id,
  orderNumber: shopifyOrder.number,
  status: mapShopifyOrderStatus(shopifyOrder.financial_status),
  totalPrice: parseFloat(shopifyOrder.total_price),
  totalTax: parseFloat(shopifyOrder.total_tax),
  totalShipping: parseFloat(shopifyOrder.total_shipping_cost),
  currency: shopifyOrder.currency,
  createdAt: new Date(shopifyOrder.created_at),
  updatedAt: new Date(shopifyOrder.updated_at),
  channel: 'SHOPIFY',
  channelOrderId: shopifyOrder.id,
};

// WooCommerce → Nexus
const nexusOrder = {
  id: wooOrder.id,
  orderNumber: wooOrder.number,
  status: mapWooOrderStatus(wooOrder.status),
  totalPrice: parseFloat(wooOrder.total),
  totalTax: parseFloat(wooOrder.total_tax),
  totalShipping: parseFloat(wooOrder.shipping_total),
  currency: wooOrder.currency,
  createdAt: new Date(wooOrder.date_created),
  updatedAt: new Date(wooOrder.date_modified),
  channel: 'WOOCOMMERCE',
  channelOrderId: wooOrder.id,
};

// Etsy → Nexus
const nexusOrder = {
  id: etsyOrder.order_id,
  orderNumber: etsyOrder.order_id,
  status: mapEtsyOrderStatus(etsyOrder.status),
  totalPrice: etsyOrder.total_price,
  totalTax: etsyOrder.total_tax_cost,
  totalShipping: etsyOrder.total_shipping_cost,
  currency: etsyOrder.currency_code,
  createdAt: new Date(etsyOrder.creation_tsz * 1000),
  updatedAt: new Date(etsyOrder.last_modified_tsz * 1000),
  channel: 'ETSY',
  channelOrderId: etsyOrder.order_id,
};
```

---

## Image Mapping

### Image Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `id` | `id` | `id` | `listing_image_id` | Image identifier |
| `url` | `src` | `src` | `url_570xN` | Image URL |
| `alt` | `alt` | `alt` | `image_name` | Alt text |
| `position` | `position` | `position` | `rank` | Display order |
| `isPrimary` | N/A | N/A | `is_primary` | Primary image flag |
| `width` | `width` | N/A | N/A | Image width |
| `height` | `height` | N/A | N/A | Image height |

### Example Image Mapping

```typescript
// Shopify → Nexus
const nexusImages = shopifyProduct.images.map((img, index) => ({
  id: img.id,
  url: img.src,
  alt: img.alt || shopifyProduct.title,
  position: img.position || index,
  isPrimary: index === 0,
  width: img.width,
  height: img.height,
  channel: 'SHOPIFY',
}));

// WooCommerce → Nexus
const nexusImages = wooProduct.images.map((img, index) => ({
  id: img.id,
  url: img.src,
  alt: img.alt || wooProduct.name,
  position: index,
  isPrimary: index === 0,
  width: null,
  height: null,
  channel: 'WOOCOMMERCE',
}));

// Etsy → Nexus
const nexusImages = etsyListing.images.map((img) => ({
  id: img.listing_image_id,
  url: img.url_570xN,
  alt: img.image_name,
  position: img.rank,
  isPrimary: img.is_primary,
  width: 570,
  height: null,
  channel: 'ETSY',
}));
```

---

## Attribute Mapping

### Attribute Fields

| Nexus Field | Shopify | WooCommerce | Etsy | Notes |
|-------------|---------|-------------|------|-------|
| `name` | `name` | `name` | `property_name` | Attribute name |
| `value` | `value` | `option` | `value_name` | Attribute value |
| `position` | `position` | `position` | N/A | Display order |
| `visible` | `visible` | `visible` | N/A | Visibility flag |

### Example Attribute Mapping

```typescript
// Shopify → Nexus
const nexusAttributes = shopifyProduct.options.map((opt) => ({
  name: opt.name,
  values: opt.values,
  position: opt.position,
  visible: true,
  channel: 'SHOPIFY',
}));

// WooCommerce → Nexus
const nexusAttributes = wooProduct.attributes.map((attr) => ({
  name: attr.name,
  values: attr.options,
  position: attr.position,
  visible: attr.visible,
  channel: 'WOOCOMMERCE',
}));

// Etsy → Nexus
const nexusAttributes = etsyListing.variations.map((var) => ({
  name: var.property_name,
  values: [var.value_name],
  position: null,
  visible: true,
  channel: 'ETSY',
}));
```

---

## Custom Field Mapping

### Extending Mappings

To add custom field mappings, extend the mapping functions:

```typescript
// Define custom mapping
const customFieldMappings = {
  SHOPIFY: {
    customField1: 'metafield.namespace.key',
    customField2: 'tags',
  },
  WOOCOMMERCE: {
    customField1: 'meta_data[0].value',
    customField2: 'attributes[0].options',
  },
  ETSY: {
    customField1: 'tags',
    customField2: 'shop_section_id',
  },
};

// Apply custom mapping
function mapCustomFields(product, channel) {
  const mappings = customFieldMappings[channel];
  const customFields = {};
  
  for (const [nexusField, channelPath] of Object.entries(mappings)) {
    customFields[nexusField] = getNestedValue(product, channelPath);
  }
  
  return customFields;
}

// Helper to get nested values
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, prop) => current?.[prop], obj);
}
```

---

## Transformation Examples

### Complete Product Transformation

```typescript
async function transformShopifyProduct(shopifyProduct) {
  return {
    // Core fields
    id: shopifyProduct.id,
    title: shopifyProduct.title,
    description: shopifyProduct.body_html,
    sku: shopifyProduct.variants[0]?.sku,
    vendor: shopifyProduct.vendor,
    productType: shopifyProduct.product_type,
    status: shopifyProduct.status === 'active' ? 'ACTIVE' : 'DRAFT',
    
    // Timestamps
    createdAt: new Date(shopifyProduct.created_at),
    updatedAt: new Date(shopifyProduct.updated_at),
    
    // Channel info
    channel: 'SHOPIFY',
    channelProductId: shopifyProduct.id,
    
    // Variants
    variants: shopifyProduct.variants.map(variant => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: parseFloat(variant.price),
      quantity: variant.inventory_quantity,
      barcode: variant.barcode,
      weight: variant.weight,
      weightUnit: variant.weight_unit,
      channelVariantId: variant.id,
    })),
    
    // Images
    images: shopifyProduct.images.map((img, idx) => ({
      id: img.id,
      url: img.src,
      alt: img.alt || shopifyProduct.title,
      position: img.position || idx,
      isPrimary: idx === 0,
    })),
    
    // Attributes
    attributes: shopifyProduct.options.map(opt => ({
      name: opt.name,
      values: opt.values,
    })),
  };
}
```

---

## Validation Rules

### Field Validation

```typescript
const validationRules = {
  title: {
    required: true,
    minLength: 3,
    maxLength: 255,
  },
  sku: {
    required: true,
    pattern: /^[A-Z0-9\-_]+$/,
    maxLength: 50,
  },
  price: {
    required: true,
    min: 0,
    pattern: /^\d+(\.\d{2})?$/,
  },
  quantity: {
    required: true,
    min: 0,
    type: 'integer',
  },
  description: {
    maxLength: 5000,
  },
};

// Validate product
function validateProduct(product) {
  const errors = [];
  
  for (const [field, rules] of Object.entries(validationRules)) {
    const value = product[field];
    
    if (rules.required && !value) {
      errors.push(`${field} is required`);
    }
    
    if (value && rules.minLength && value.length < rules.minLength) {
      errors.push(`${field} must be at least ${rules.minLength} characters`);
    }
    
    if (value && rules.maxLength && value.length > rules.maxLength) {
      errors.push(`${field} must be at most ${rules.maxLength} characters`);
    }
    
    if (value && rules.pattern && !rules.pattern.test(value)) {
      errors.push(`${field} format is invalid`);
    }
  }
  
  return errors;
}
```

---

## Support

For data mapping questions:
- **Documentation**: https://docs.nexus-commerce.com
- **API Reference**: See MARKETPLACE-API-DOCUMENTATION.md
- **Email**: support@nexus-commerce.com

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0

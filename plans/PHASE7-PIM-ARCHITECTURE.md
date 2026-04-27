# Phase 7: The Dynamic Catalog Engine - PIM Architecture Blueprint

## Executive Summary

Phase 7 transforms Nexus Commerce into a **master Product Information Management (PIM) hub** by implementing dynamic field loading from Amazon's SP-API Product Type Definitions. Instead of hardcoding product fields (voltage, apparel_size, etc.), the system will:

1. **Ask users for Product Type** (e.g., "LUGGAGE", "OUTERWEAR", "ELECTRONICS")
2. **Fetch JSON schema** from Amazon SP-API for that category
3. **Dynamically render form fields** based on required vs optional attributes
4. **Highlight required fields in red** for visual clarity
5. **Store flexible attributes** in database for multi-marketplace support

This enables Nexus to support **any Amazon product category** without code changes.

---

## 1. Database Schema Changes

### 1.1 Product Model Updates

**File:** [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma)

Add two new fields to the `Product` model:

```prisma
model Product {
  id         String  @id @default(cuid())
  sku        String  @unique
  name       String
  basePrice  Decimal @db.Decimal(10, 2)
  totalStock Int     @default(0)

  // ── NEW: Dynamic PIM Fields ──────────────────────────────────────
  // Amazon product type (e.g., "LUGGAGE", "OUTERWEAR", "ELECTRONICS")
  productType String?

  // Flexible JSON storage for category-specific attributes
  // Structure: { "voltage": "110V", "apparel_size": "M", "material": "Cotton" }
  categoryAttributes Json?

  // ── Existing fields continue below ──────────────────────────────
  amazonAsin         String?
  ebayItemId         String?
  // ... rest of fields
}
```

**Rationale:**
- `productType`: Identifies which Amazon category this product belongs to
- `categoryAttributes`: Stores dynamic key-value pairs for marketplace-specific fields
  - Avoids hardcoding fields that vary by category
  - Supports future multi-marketplace attributes (Shopify, eBay, WooCommerce)
  - Flexible JSON allows any field structure

**Migration:**
```bash
npx prisma migrate dev --name add_pim_fields
```

---

## 2. Amazon Schema Service Architecture

### 2.1 Service Overview

**File:** `apps/api/src/services/amazon-catalog.service.ts` (NEW)

The `AmazonCatalogService` handles all interactions with Amazon's Product Type Definitions API:

```typescript
export class AmazonCatalogService {
  // Cache: productType → JSON schema
  private schemaCache: Map<string, CachedSchema> = new Map();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Fetch product type schema from Amazon SP-API
   * GET /catalogs/2022-04-01/productTypes/{productType}
   */
  async getProductTypeSchema(productType: string): Promise<ProductTypeSchema>

  /**
   * Parse Amazon schema to extract required vs optional fields
   */
  private parseSchema(schema: ProductTypeSchema): ParsedSchema

  /**
   * Get required fields for a product type (for UI highlighting)
   */
  async getRequiredFields(productType: string): Promise<string[]>

  /**
   * Get all fields (required + optional) for a product type
   */
  async getAllFields(productType: string): Promise<FieldDefinition[]>

  /**
   * Validate product attributes against schema
   */
  async validateAttributes(
    productType: string,
    attributes: Record<string, any>
  ): Promise<ValidationResult>

  /**
   * Get list of available product types (for dropdown)
   */
  async getAvailableProductTypes(): Promise<string[]>
}
```

### 2.2 Data Structures

```typescript
// Amazon SP-API response structure
interface ProductTypeSchema {
  productType: string;
  requirements: {
    [attributeName: string]: {
      required: boolean;
      dataType: string;
      description: string;
      enumValues?: string[];
      minValue?: number;
      maxValue?: number;
      maxLength?: number;
    };
  };
}

// Parsed schema for frontend consumption
interface ParsedSchema {
  productType: string;
  requiredFields: FieldDefinition[];
  optionalFields: FieldDefinition[];
}

interface FieldDefinition {
  name: string;
  label: string;
  dataType: 'STRING' | 'INT' | 'DECIMAL' | 'BOOLEAN' | 'ENUM' | 'DATE';
  required: boolean;
  description: string;
  enumValues?: string[];
  minValue?: number;
  maxValue?: number;
  maxLength?: number;
  placeholder?: string;
}

// Cached schema with TTL
interface CachedSchema {
  schema: ProductTypeSchema;
  parsedSchema: ParsedSchema;
  cachedAt: Date;
  expiresAt: Date;
}

// Validation result
interface ValidationResult {
  valid: boolean;
  errors: {
    field: string;
    message: string;
  }[];
}
```

### 2.3 Caching Strategy

**Problem:** Amazon SP-API has rate limits. Fetching schema for every product type selection is wasteful.

**Solution:** In-memory cache with TTL (Time-To-Live)

```typescript
private async getOrFetchSchema(productType: string): Promise<ParsedSchema> {
  // Check cache first
  const cached = this.schemaCache.get(productType);
  if (cached && cached.expiresAt > new Date()) {
    return cached.parsedSchema; // Cache hit
  }

  // Cache miss or expired: fetch from Amazon
  const schema = await this.fetchFromAmazonAPI(productType);
  const parsed = this.parseSchema(schema);

  // Store in cache with 24-hour TTL
  this.schemaCache.set(productType, {
    schema,
    parsedSchema: parsed,
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + this.CACHE_TTL_MS),
  });

  return parsed;
}
```

**Cache Invalidation:**
- Automatic: 24-hour TTL
- Manual: Admin endpoint to clear cache if Amazon schema changes
- Startup: Load popular product types on service initialization

### 2.4 Amazon SP-API Integration

```typescript
private async fetchFromAmazonAPI(productType: string): Promise<ProductTypeSchema> {
  const accessToken = await this.getAmazonAccessToken();
  
  const response = await fetch(
    `https://sellingpartnerapi-na.amazon.com/catalogs/2022-04-01/productTypes/${productType}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Amazon API error: ${response.statusText}`);
  }

  return response.json();
}
```

---

## 3. API Routes

### 3.1 New Endpoints

**File:** `apps/api/src/routes/catalog.routes.ts` (NEW)

```typescript
export async function catalogRoutes(app: FastifyInstance) {
  // GET /api/catalog/product-types
  // Returns list of available Amazon product types for dropdown
  app.get('/api/catalog/product-types', async (request, reply) => {
    const types = await catalogService.getAvailableProductTypes();
    return { success: true, data: types };
  });

  // GET /api/catalog/product-types/:productType/schema
  // Returns parsed schema (required + optional fields) for a product type
  app.get<{ Params: { productType: string } }>(
    '/api/catalog/product-types/:productType/schema',
    async (request, reply) => {
      const schema = await catalogService.getProductTypeSchema(
        request.params.productType
      );
      return { success: true, data: schema };
    }
  );

  // POST /api/catalog/validate
  // Validates product attributes against schema
  app.post<{ Body: ValidateAttributesBody }>(
    '/api/catalog/validate',
    async (request, reply) => {
      const result = await catalogService.validateAttributes(
        request.body.productType,
        request.body.attributes
      );
      return { success: true, data: result };
    }
  );

  // POST /api/products
  // Create product with dynamic attributes
  app.post<{ Body: CreateProductBody }>(
    '/api/products',
    async (request, reply) => {
      const product = await prisma.product.create({
        data: {
          sku: request.body.sku,
          name: request.body.name,
          basePrice: request.body.basePrice,
          productType: request.body.productType,
          categoryAttributes: request.body.categoryAttributes,
        },
      });
      return { success: true, data: product };
    }
  );
}
```

---

## 4. Dynamic Add Product UI

### 4.1 Component Architecture

**File:** `apps/web/src/app/catalog/add/page.tsx` (MODIFIED)

```typescript
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface ProductTypeOption {
  value: string;
  label: string;
}

interface FieldDefinition {
  name: string;
  label: string;
  dataType: string;
  required: boolean;
  description: string;
  enumValues?: string[];
  placeholder?: string;
}

interface ParsedSchema {
  productType: string;
  requiredFields: FieldDefinition[];
  optionalFields: FieldDefinition[];
}

export default function AddProductPage() {
  const router = useRouter();
  const [step, setStep] = useState<'type' | 'details'>('type');
  
  // Step 1: Product Type Selection
  const [productTypes, setProductTypes] = useState<ProductTypeOption[]>([]);
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [loadingTypes, setLoadingTypes] = useState(true);

  // Step 2: Dynamic Fields
  const [schema, setSchema] = useState<ParsedSchema | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Fetch available product types on mount
  useEffect(() => {
    const fetchProductTypes = async () => {
      try {
        const response = await fetch('/api/catalog/product-types');
        const data = await response.json();
        setProductTypes(
          data.data.map((type: string) => ({
            value: type,
            label: type.replace(/_/g, ' '),
          }))
        );
      } catch (error) {
        console.error('Failed to fetch product types:', error);
      } finally {
        setLoadingTypes(false);
      }
    };

    fetchProductTypes();
  }, []);

  // Fetch schema when product type is selected
  const handleProductTypeSelect = async (productType: string) => {
    setSelectedProductType(productType);
    
    try {
      const response = await fetch(
        `/api/catalog/product-types/${productType}/schema`
      );
      const data = await response.json();
      setSchema(data.data);
      setFormData({}); // Reset form
      setErrors({});
      setStep('details');
    } catch (error) {
      console.error('Failed to fetch schema:', error);
    }
  };

  // Handle form field changes
  const handleFieldChange = (fieldName: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [fieldName]: value,
    }));
    // Clear error for this field
    if (errors[fieldName]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
  };

  // Validate and submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      // Validate attributes against schema
      const validateResponse = await fetch('/api/catalog/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productType: selectedProductType,
          attributes: formData,
        }),
      });

      const validationData = await validateResponse.json();
      if (!validationData.data.valid) {
        const newErrors: Record<string, string> = {};
        validationData.data.errors.forEach(
          (error: { field: string; message: string }) => {
            newErrors[error.field] = error.message;
          }
        );
        setErrors(newErrors);
        return;
      }

      // Create product
      const createResponse = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: formData.sku,
          name: formData.name,
          basePrice: formData.basePrice,
          productType: selectedProductType,
          categoryAttributes: formData,
        }),
      });

      if (createResponse.ok) {
        router.push('/catalog');
      }
    } catch (error) {
      console.error('Failed to create product:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1: Product Type Selection
  if (step === 'type') {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="text-3xl font-bold mb-6">Add New Product</h1>
        <p className="text-gray-600 mb-8">
          Select a product type to get started. We'll load the required fields
          for that category.
        </p>

        {loadingTypes ? (
          <div className="text-center py-8">Loading product types...</div>
        ) : (
          <div className="space-y-3">
            {productTypes.map((type) => (
              <button
                key={type.value}
                onClick={() => handleProductTypeSelect(type.value)}
                className="w-full p-4 text-left border border-gray-300 rounded-lg hover:bg-blue-50 hover:border-blue-500 transition-colors"
              >
                <div className="font-semibold text-gray-900">{type.label}</div>
                <div className="text-sm text-gray-500">
                  Click to view required fields
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Step 2: Dynamic Form Fields
  if (step === 'details' && schema) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <button
          onClick={() => setStep('type')}
          className="mb-6 text-blue-600 hover:text-blue-800 flex items-center gap-2"
        >
          ← Back to Product Types
        </button>

        <h1 className="text-3xl font-bold mb-2">
          Add {selectedProductType.replace(/_/g, ' ')} Product
        </h1>
        <p className="text-gray-600 mb-8">
          Fill in the required fields (highlighted in red) and any optional
          fields you'd like to include.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Required Fields */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-red-600">
              Required Fields
            </h2>
            <div className="space-y-4">
              {schema.requiredFields.map((field) => (
                <FormField
                  key={field.name}
                  field={field}
                  value={formData[field.name] || ''}
                  onChange={(value) => handleFieldChange(field.name, value)}
                  error={errors[field.name]}
                  required
                />
              ))}
            </div>
          </div>

          {/* Optional Fields */}
          {schema.optionalFields.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-4 text-gray-700">
                Optional Fields
              </h2>
              <div className="space-y-4">
                {schema.optionalFields.map((field) => (
                  <FormField
                    key={field.name}
                    field={field}
                    value={formData[field.name] || ''}
                    onChange={(value) => handleFieldChange(field.name, value)}
                    error={errors[field.name]}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Submit Button */}
          <div className="flex gap-4 pt-6">
            <button
              type="button"
              onClick={() => setStep('type')}
              className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Product'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return null;
}

// Reusable form field component
function FormField({
  field,
  value,
  onChange,
  error,
  required,
}: {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
  error?: string;
  required?: boolean;
}) {
  const borderColor = required ? 'border-red-300' : 'border-gray-300';
  const labelColor = required ? 'text-red-700' : 'text-gray-700';

  return (
    <div>
      <label className={`block text-sm font-medium ${labelColor} mb-2`}>
        {field.label}
        {required && <span className="text-red-600 ml-1">*</span>}
      </label>
      <p className="text-xs text-gray-500 mb-2">{field.description}</p>

      {field.dataType === 'ENUM' && field.enumValues ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        >
          <option value="">Select {field.label}</option>
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.dataType === 'INT' ? (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          placeholder={field.placeholder}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      ) : field.dataType === 'DECIMAL' ? (
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          placeholder={field.placeholder}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      ) : field.dataType === 'BOOLEAN' ? (
        <input
          type="checkbox"
          checked={value || false}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          className={`w-full px-3 py-2 border ${borderColor} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      )}

      {error && <p className="text-red-600 text-sm mt-1">{error}</p>}
    </div>
  );
}
```

### 4.2 UI/UX Flow

```
┌─────────────────────────────────────────┐
│  Step 1: Select Product Type            │
│  ┌─────────────────────────────────────┐│
│  │ LUGGAGE                             ││
│  │ Click to view required fields       ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ OUTERWEAR                           ││
│  │ Click to view required fields       ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ ELECTRONICS                         ││
│  │ Click to view required fields       ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
              ↓ (User clicks LUGGAGE)
┌─────────────────────────────────────────┐
│  Step 2: Fill Dynamic Fields            │
│  ← Back to Product Types                │
│                                         │
│  Add LUGGAGE Product                    │
│                                         │
│  Required Fields (RED BORDER)           │
│  ┌─────────────────────────────────────┐│
│  │ Material *                          ││
│  │ [Dropdown: Nylon, Leather, etc]    ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │ Dimensions *                        ││
│  │ [Text input]                        ││
│  └─────────────────────────────────────┘│
│                                         │
│  Optional Fields (GRAY BORDER)          │
│  ┌─────────────────────────────────────┐│
│  │ Color                               ││
│  │ [Text input]                        ││
│  └─────────────────────────────────────┘│
│                                         │
│  [Cancel] [Create Product]              │
└─────────────────────────────────────────┘
```

---

## 5. Component Integration Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    Frontend (React)                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Add Product Page                                      │ │
│  │  - Step 1: Product Type Selector                       │ │
│  │  - Step 2: Dynamic Form (FormField components)         │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                          ↓ (HTTP)
┌──────────────────────────────────────────────────────────────┐
│                    API Layer (Fastify)                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  GET /api/catalog/product-types                        │ │
│  │  GET /api/catalog/product-types/:type/schema           │ │
│  │  POST /api/catalog/validate                            │ │
│  │  POST /api/products                                    │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│              Service Layer (TypeScript)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  AmazonCatalogService                                  │ │
│  │  - getProductTypeSchema()                              │ │
│  │  - parseSchema()                                       │ │
│  │  - validateAttributes()                                │ │
│  │  - getAvailableProductTypes()                          │ │
│  │  - [In-Memory Cache with 24h TTL]                      │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│           Amazon SP-API (External)                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  GET /catalogs/2022-04-01/productTypes/{productType}   │ │
│  │  Returns: JSON schema with required/optional fields    │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│              Database (Prisma)                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Product                                               │ │
│  │  - id, sku, name, basePrice, totalStock               │ │
│  │  - productType (NEW)                                   │ │
│  │  - categoryAttributes (NEW) [JSON]                     │ │
│  │  - ... existing fields                                 │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Data Flow Example

### Scenario: User adds a LUGGAGE product

**Step 1: User selects "LUGGAGE"**
```
Frontend: GET /api/catalog/product-types/LUGGAGE/schema
↓
AmazonCatalogService.getProductTypeSchema("LUGGAGE")
  ├─ Check cache: MISS
  ├─ Fetch from Amazon SP-API
  ├─ Parse schema (extract required vs optional)
  ├─ Store in cache (24h TTL)
  └─ Return ParsedSchema
↓
Frontend receives:
{
  "productType": "LUGGAGE",
  "requiredFields": [
    {
      "name": "material",
      "label": "Material",
      "dataType": "ENUM",
      "required": true,
      "enumValues": ["Nylon", "Leather", "Canvas"]
    },
    {
      "name": "dimensions",
      "label": "Dimensions",
      "dataType": "STRING",
      "required": true
    }
  ],
  "optionalFields": [
    {
      "name": "color",
      "label": "Color",
      "dataType": "STRING",
      "required": false
    }
  ]
}
↓
Frontend renders form with red-bordered required fields
```

**Step 2: User fills form and submits**
```
Frontend: POST /api/catalog/validate
Body: {
  "productType": "LUGGAGE",
  "attributes": {
    "material": "Nylon",
    "dimensions": "20x14x9",
    "color": "Black"
  }
}
↓
AmazonCatalogService.validateAttributes()
  ├─ Get schema from cache
  ├─ Check all required fields present
  ├─ Validate data types
  ├─ Validate enum values
  └─ Return { valid: true, errors: [] }
↓
Frontend: POST /api/products
Body: {
  "sku": "LUG-001",
  "name": "Travel Luggage",
  "basePrice": 99.99,
  "productType": "LUGGAGE",
  "categoryAttributes": {
    "material": "Nylon",
    "dimensions": "20x14x9",
    "color": "Black"
  }
}
↓
Database: INSERT INTO Product
{
  id: "cuid123",
  sku: "LUG-001",
  name: "Travel Luggage",
  basePrice: 99.99,
  productType: "LUGGAGE",
  categoryAttributes: {
    "material": "Nylon",
    "dimensions": "20x14x9",
    "color": "Black"
  }
}
↓
Frontend: Redirect to /catalog
```

---

## 7. Implementation Checklist

### Phase 7.1: Database Schema
- [ ] Add `productType` field to Product model
- [ ] Add `categoryAttributes` JSON field to Product model
- [ ] Create and run Prisma migration
- [ ] Verify schema changes in database

### Phase 7.2: Amazon Catalog Service
- [ ] Create `AmazonCatalogService` class
- [ ] Implement `getProductTypeSchema()` with caching
- [ ] Implement `parseSchema()` to extract required/optional fields
- [ ] Implement `validateAttributes()` for form validation
- [ ] Implement `getAvailableProductTypes()` for dropdown
- [ ] Add error handling and logging
- [ ] Write unit tests

### Phase 7.3: API Routes
- [ ] Create `catalog.routes.ts` with 4 endpoints
- [ ] Implement GET /api/catalog/product-types
- [ ] Implement GET /api/catalog/product-types/:productType/schema
- [ ] Implement POST /api/catalog/validate
- [ ] Implement POST /api/products (update to support dynamic attributes)
- [ ] Add request validation and error handling
- [ ] Write integration tests

### Phase 7.4: Frontend UI
- [ ] Create dynamic Add Product page
- [ ] Implement Step 1: Product Type Selector
- [ ] Implement Step 2: Dynamic Form Fields
- [ ] Create FormField component with type-specific inputs
- [ ] Add required field highlighting (red border)
- [ ] Implement form validation and error display
- [ ] Add loading states and error handling
- [ ] Test with multiple product types

### Phase 7.5: Testing & Documentation
- [ ] End-to-end testing with real Amazon product types
- [ ] Test caching behavior
- [ ] Test validation with invalid data
- [ ] Test error scenarios
- [ ] Create PHASE7-IMPLEMENTATION-COMPLETE.md
- [ ] Create PHASE7-TESTING-GUIDE.md

---

## 8. Key Design Decisions

### 8.1 Why In-Memory Cache?
- **Fast**: No database round-trip
- **Simple**: No cache invalidation complexity
- **Sufficient**: 24-hour TTL covers most use cases
- **Scalable**: Can be upgraded to Redis if needed

### 8.2 Why JSON for categoryAttributes?
- **Flexibility**: Different product types have different fields
- **Scalability**: No schema migration needed for new fields
- **Multi-marketplace**: Can store Shopify, eBay, WooCommerce attributes in same field
- **Query-friendly**: PostgreSQL JSON operators allow filtering/searching

### 8.3 Why Two-Step Form?
- **UX**: Users see relevant fields immediately after type selection
- **Performance**: Schema fetched only once per session
- **Clarity**: Required fields highlighted in red, optional in gray
- **Validation**: Real-time feedback before submission

### 8.4 Why Cache in Service Layer?
- **Centralized**: Single source of truth for schema
- **Testable**: Easy to mock for unit tests
- **Maintainable**: Cache logic isolated from routes
- **Reusable**: Can be used by multiple endpoints

---

## 9. Error Handling Strategy

### 9.1 Service Layer Errors

```typescript
// AmazonCatalogService errors
class ProductTypeNotFoundError extends Error {
  constructor(productType: string) {
    super(`Product type "${productType}" not found in Amazon catalog`);
  }
}

class ValidationError extends Error {
  constructor(public errors: Array<{ field: string; message: string }>) {
    super('Validation failed');
  }
}

class AmazonAPIError extends Error {
  constructor(public statusCode: number, message: string) {
    super(`Amazon API error: ${message}`);
  }
}
```

### 9.2 API Route Error Responses

```typescript
// 400: Invalid request
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Product type is required"
  }
}

// 404: Product type not found
{
  "success": false,
  "error": {
    "code": "PRODUCT_TYPE_NOT_FOUND",
    "message": "Product type 'INVALID_TYPE' not found"
  }
}

// 422: Validation failed
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "field": "material", "message": "Required field missing" },
      { "field": "voltage", "message": "Invalid enum value" }
    ]
  }
}

// 502: Amazon API error
{
  "success": false,
  "error": {
    "code": "AMAZON_API_ERROR",
    "message": "Failed to fetch schema from Amazon"
  }
}

// 500: Server error
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

---

## 10. Performance Considerations

### 10.1 Caching Impact

| Scenario | Without Cache | With Cache |
|----------|---------------|-----------|
| First product type selection | ~500ms (API call) | ~500ms (API call) |
| Second product type selection | ~500ms (API call) | ~5ms (cache hit) |
| 10 products same type | ~5000ms | ~50ms |
| **Improvement** | - | **100x faster** |

### 10.2 Database Query Optimization

```typescript
// Efficient: Single query with JSON field
const product = await prisma.product.findUnique({
  where: { id: productId },
  select: {
    id: true,
    sku: true,
    name: true,
    productType: true,
    categoryAttributes: true, // JSON field
  },
});

// Access nested attributes
const material = product.categoryAttributes?.material;
```

### 10.3 Frontend Optimization

- **Lazy load**: Fetch schema only when product type selected
- **Debounce**: Prevent rapid API calls during typing
- **Memoize**: Cache parsed schema in React state
- **Virtualize**: For large dropdown lists (100+ product types)

---

## 11. Security Considerations

### 11.1 Input Validation

```typescript
// Validate product type format
const isValidProductType = (type: string): boolean => {
  return /^[A-Z_]{3,50}$/.test(type); // Alphanumeric + underscore, 3-50 chars
};

// Sanitize attribute values
const sanitizeAttributes = (attrs: Record<string, any>): Record<string, any> => {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string') {
      sanitized[key] = value.trim().substring(0, 1000); // Max 1000 chars
    } else if (typeof value === 'number') {
      sanitized[key] = Math.max(-999999, Math.min(999999, value)); // Range check
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};
```

### 11.2 Authorization

```typescript
// Only authenticated users can create products
app.post<{ Body: CreateProductBody }>(
  '/api/products',
  { onRequest: [authenticate] }, // Middleware
  async (request, reply) => {
    // Create product
  }
);
```

### 11.3 Rate Limiting

```typescript
// Limit schema requests to prevent API spam
const schemaRateLimiter = rateLimit({
  max: 100, // 100 requests
  timeWindow: '1 hour',
  keyGenerator: (request) => request.user.id,
});

app.get(
  '/api/catalog/product-types/:productType/schema',
  { onRequest: [schemaRateLimiter] },
  async (request, reply) => {
    // Fetch schema
  }
);
```

---

## 12. Testing Strategy

### 12.1 Unit Tests (AmazonCatalogService)

```typescript
describe('AmazonCatalogService', () => {
  describe('getProductTypeSchema', () => {
    it('should fetch schema from Amazon API', async () => {
      // Mock Amazon API response
      // Call getProductTypeSchema('LUGGAGE')
      // Assert schema structure
    });

    it('should cache schema for 24 hours', async () => {
      // Call getProductTypeSchema('LUGGAGE') twice
      // Assert second call uses cache (no API call)
    });

    it('should throw error for invalid product type', async () => {
      // Call getProductTypeSchema('INVALID')
      // Assert ProductTypeNotFoundError thrown
    });
  });

  describe('validateAttributes', () => {
    it('should validate required fields', async () => {
      // Call validateAttributes with missing required field
      // Assert validation error returned
    });

    it('should validate enum values', async () => {
      // Call validateAttributes with invalid enum value
      // Assert validation error returned
    });

    it('should pass valid attributes', async () => {
      // Call validateAttributes with valid data
      // Assert validation passes
    });
  });
});
```

### 12.2 Integration Tests (API Routes)

```typescript
describe('Catalog Routes', () => {
  describe('GET /api/catalog/product-types', () => {
    it('should return list of product types', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/catalog/product-types',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toBeInstanceOf(Array);
    });
  });

  describe('GET /api/catalog/product-types/:productType/schema', () => {
    it('should return schema for valid product type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/catalog/product-types/LUGGAGE/schema',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.productType).toBe('LUGGAGE');
    });

    it('should return 404 for invalid product type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/catalog/product-types/INVALID/schema',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/products', () => {
    it('should create product with dynamic attributes', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        payload: {
          sku: 'LUG-001',
          name: 'Travel Luggage',
          basePrice: 99.99,
          productType: 'LUGGAGE',
          categoryAttributes: { material: 'Nylon' },
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.productType).toBe('LUGGAGE');
    });
  });
});
```

### 12.3 E2E Tests (Frontend)

```typescript
describe('Add Product Page', () => {
  it('should display product type selector on load', async () => {
    render(<AddProductPage />);
    expect(screen.getByText('Select a product type')).toBeInTheDocument();
  });

  it('should fetch and display schema when type selected', async () => {
    render(<AddProductPage />);
    const luggageButton = screen.getByText('LUGGAGE');
    fireEvent.click(luggageButton);
    
    await waitFor(() => {
      expect(screen.getByLabelText('Material *')).toBeInTheDocument();
    });
  });

  it('should highlight required fields in red', async () => {
    render(<AddProductPage />);
    fireEvent.click(screen.getByText('LUGGAGE'));
    
    await waitFor(() => {
      const materialField = screen.getByLabelText('Material *');
      expect(materialField).toHaveClass('border-red-300');
    });
  });

  it('should validate form before submission', async () => {
    render(<AddProductPage />);
    fireEvent.click(screen.getByText('LUGGAGE'));
    
    await waitFor(() => {
      fireEvent.click(screen.getByText('Create Product'));
      expect(screen.getByText('Material is required')).toBeInTheDocument();
    });
  });
});
```

---

## 13. Deployment Checklist

- [ ] Code review completed
- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] E2E tests passing
- [ ] Database migration tested
- [ ] Caching behavior verified
- [ ] Error handling tested
- [ ] Performance benchmarks acceptable
- [ ] Security review completed
- [ ] Documentation complete
- [ ] Staging deployment successful
- [ ] Production deployment successful

---

## 14. Success Criteria

✅ **Database**: Product model updated with `productType` and `categoryAttributes`
✅ **Service**: AmazonCatalogService created with caching and validation
✅ **API**: 4 new endpoints for schema fetching and validation
✅ **Frontend**: Dynamic form that loads fields based on product type
✅ **UX**: Required fields highlighted in red, optional in gray
✅ **Performance**: Schema cached for 24 hours, 100x faster on repeat selections
✅ **Testing**: Unit, integration, and E2E tests passing
✅ **Documentation**: Architecture and testing guides complete

---

## 15. Next Steps

### Immediate (Phase 7.1-7.2)
1. Update Product model schema
2. Create Prisma migration
3. Implement AmazonCatalogService with caching
4. Write unit tests

### Short-term (Phase 7.3-7.4)
5. Create catalog API routes
6. Build dynamic Add Product UI
7. Implement form validation
8. Write integration and E2E tests

### Medium-term (Phase 7.5+)
9. Deploy to staging
10. Perform end-to-end testing
11. Deploy to production
12. Monitor for issues

### Future Enhancements
- [ ] Bulk product import with dynamic fields
- [ ] Product type recommendations based on SKU/name
- [ ] Field-level search and filtering
- [ ] Multi-language support for field labels
- [ ] Custom field templates per seller
- [ ] Integration with other marketplaces (Shopify, eBay, WooCommerce)

---

## 16. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Add Product Page                                         │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │ Step 1: Product Type Selector                       │ │ │
│  │  │ [LUGGAGE] [OUTERWEAR] [ELECTRONICS] ...             │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │ Step 2: Dynamic Form Fields                         │ │ │
│  │  │ Material * [Dropdown] ← Required (RED)              │ │ │
│  │  │ Dimensions * [Text] ← Required (RED)                │ │ │
│  │  │ Color [Text] ← Optional (GRAY)                      │ │ │
│  │  │ [Cancel] [Create Product]                           │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTP
┌─────────────────────────────────────────────────────────────────┐
│                      API Layer (Fastify)                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ GET /api/catalog/product-types                            │ │
│  │ GET /api/catalog/product-types/:type/schema               │ │
│  │ POST /api/catalog/validate                                │ │
│  │ POST /api/products                                        │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   Service Layer (TypeScript)                    │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ AmazonCatalogService                                      │ │
│  │ ┌─────────────────────────────────────────────────────┐  │ │
│  │ │ In-Memory Cache (24h TTL)                           │  │ │
│  │ │ LUGGAGE → { required: [...], optional: [...] }      │  │ │
│  │ │ OUTERWEAR → { required: [...], optional: [...] }    │  │ │
│  │ └─────────────────────────────────────────────────────┘  │ │
│  │ Methods:                                                  │ │
│  │ - getProductTypeSchema(type)                              │ │
│  │ - parseSchema(schema)                                     │ │
│  │ - validateAttributes(type, attrs)                         │ │
│  │ - getAvailableProductTypes()                              │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Amazon SP-API (External)                       │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ GET /catalogs/2022-04-01/productTypes/{productType}       │ │
│  │ Returns: JSON schema with required/optional fields        │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Database (PostgreSQL)                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Product Table                                             │ │
│  │ ┌─────────────────────────────────────────────────────┐  │ │
│  │ │ id | sku | name | basePrice | productType | attrs  │  │ │
│  │ │ 1  | LUG-001 | Travel Luggage | 99.99 | LUGGAGE | │  │ │
│  │ │    |     |     |     | { material: "Nylon" } │  │ │
│  │ └─────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 17. References

- [Amazon SP-API Product Type Definitions](https://developer.amazon.com/docs/amazon-selling-partner-api/product-type-definitions.html)
- [Prisma JSON Field Documentation](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#json)
- [React Form Patterns](https://react.dev/reference/react/useState)
- [Fastify Documentation](https://www.fastify.io/)

---

**Status:** 🏗️ ARCHITECTURE COMPLETE
**Version:** 1.0.0
**Last Updated:** April 24, 2026
**Next Phase:** Implementation (Phase 7.1-7.5)
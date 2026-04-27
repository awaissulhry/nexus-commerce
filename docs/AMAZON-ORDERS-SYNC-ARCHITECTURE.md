# Amazon Orders & Financials Sync Architecture
## Phase 2: Orders Management System

**Document Version:** 1.0  
**Date:** 2026-04-24  
**Status:** Architecture Review Ready  
**Phase:** Phase 2 (Orders & Financials)

---

## Executive Summary

This document outlines the architecture for Phase 2 of Nexus Commerce, which will implement comprehensive order and financial management synced from Amazon Seller Central. Building on the parent-child product hierarchy established in Phase 1, Phase 2 will:

1. **Sync Orders** from Amazon SP-API OrdersV0 endpoint
2. **Track Financials** from Amazon SP-API FinancesV0 endpoint
3. **Link Orders to Products** using the Phase 1 product database
4. **Provide Order Management UI** mirroring Seller Central experience
5. **Calculate Financial Metrics** for business intelligence

---

## 1. Database Schema Enhancements

### 1.1 Order Model

```prisma
model Order {
  // Primary Identifier
  id                    String    @id @default(cuid())
  amazonOrderId         String    @unique  // e.g., "123-1234567-1234567"
  
  // Order Metadata
  purchaseDate          DateTime
  lastUpdateDate        DateTime?
  status                String    // "Pending", "Unshipped", "Partially Shipped", "Shipped", "Cancelled", "Unfulfillable"
  fulfillmentChannel    String    // "AFN" (FBA) or "MFN" (FBM)
  
  // Buyer Information
  buyerName             String
  buyerEmail            String?
  buyerPhone            String?
  
  // Shipping Address
  shippingAddress       Json      // { street1, street2, city, state, postalCode, country }
  
  // Financial Summary
  totalAmount           Decimal   @db.Decimal(12, 2)  // Total order value
  currencyCode          String    @default("USD")
  
  // Fulfillment Details
  shipmentDate          DateTime?
  deliveryDate          DateTime?
  trackingNumber        String?
  carrier               String?   // "UPS", "FedEx", "USPS", etc.
  
  // Relations
  items                 OrderItem[]
  financialTransactions FinancialTransaction[]
  syncLogs              SyncLog[]
  
  // Metadata
  amazonMetadata        Json?     // Store additional Amazon response data
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  
  // Indexes
  @@index([amazonOrderId])
  @@index([purchaseDate])
  @@index([status])
  @@index([fulfillmentChannel])
  @@index([buyerEmail])
}
```

**Key Design Decisions:**
- `amazonOrderId` is unique and indexed for fast lookups
- `status` is a string enum for flexibility (can add new statuses)
- `shippingAddress` stored as JSON for flexibility
- `amazonMetadata` stores raw API response for debugging
- Indexes on frequently queried fields (date, status, channel)

---

### 1.2 OrderItem Model

```prisma
model OrderItem {
  // Primary Identifier
  id                    String    @id @default(cuid())
  amazonOrderItemId     String    @unique  // e.g., "12345678901234"
  
  // Order Reference
  order                 Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  orderId               String
  
  // Product Reference (Links to Phase 1 Product)
  product               Product   @relation(fields: [productId], references: [id], onDelete: SetNull)
  productId             String?   // Nullable in case product is deleted
  
  // SKU Tracking (for matching if product not found)
  sellerSku             String    // Seller's SKU
  asin                  String?   // Amazon ASIN
  
  // Item Details
  title                 String    // Product title from order
  quantity              Int
  
  // Pricing
  itemPrice             Decimal   @db.Decimal(10, 2)  // Price per unit
  itemTax               Decimal   @db.Decimal(10, 2)  // Tax per unit
  shippingPrice         Decimal   @db.Decimal(10, 2)  // Shipping per unit
  shippingTax           Decimal   @db.Decimal(10, 2)  // Shipping tax per unit
  
  // Calculated Fields
  subtotal              Decimal   @db.Decimal(12, 2)  // (itemPrice + itemTax) * quantity
  totalWithShipping     Decimal   @db.Decimal(12, 2)  // subtotal + (shippingPrice + shippingTax) * quantity
  
  // Fulfillment Status
  fulfillmentStatus     String    // "Pending", "Shipped", "Cancelled", "Returned"
  
  // Metadata
  amazonMetadata        Json?     // Store additional Amazon response data
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  
  // Indexes
  @@index([orderId])
  @@index([productId])
  @@index([sellerSku])
  @@index([asin])
  @@unique([orderId, amazonOrderItemId])
}
```

**Key Design Decisions:**
- `productId` is nullable to handle deleted products
- `sellerSku` and `asin` stored for matching and debugging
- Calculated fields (`subtotal`, `totalWithShipping`) for quick access
- Cascade delete on order deletion
- Unique constraint on (orderId, amazonOrderItemId) to prevent duplicates

---

### 1.3 FinancialTransaction Model

```prisma
model FinancialTransaction {
  // Primary Identifier
  id                    String    @id @default(cuid())
  amazonTransactionId   String    @unique  // e.g., "amzn1.sp.transaction.v1.123456"
  
  // Order Reference
  order                 Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  orderId               String
  
  // Transaction Details
  transactionType       String    // "Order", "Refund", "FBA_Fee", "Shipping_Fee", "Tax", "Adjustment"
  transactionDate       DateTime
  
  // Financial Amounts
  amount                Decimal   @db.Decimal(12, 2)  // Can be positive or negative
  currencyCode          String    @default("USD")
  
  // Fee Breakdown (for Order type)
  amazonFee             Decimal   @db.Decimal(10, 2)  @default(0)  // Referral fee
  fbaFee                Decimal   @db.Decimal(10, 2)  @default(0)  // FBA fulfillment fee
  paymentServicesFee    Decimal   @db.Decimal(10, 2)  @default(0)  // Payment processing fee
  otherFees             Decimal   @db.Decimal(10, 2)  @default(0)  // Other miscellaneous fees
  
  // Net Revenue Calculation
  grossRevenue          Decimal   @db.Decimal(12, 2)  // Total before fees
  netRevenue            Decimal   @db.Decimal(12, 2)  // grossRevenue - totalFees
  
  // Status
  status                String    // "Pending", "Completed", "Reversed"
  
  // Metadata
  amazonMetadata        Json?     // Store additional Amazon response data
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  
  // Indexes
  @@index([orderId])
  @@index([transactionType])
  @@index([transactionDate])
  @@index([status])
}
```

**Key Design Decisions:**
- `transactionType` is flexible string for various transaction types
- Fee breakdown allows detailed financial analysis
- `netRevenue` calculated field for quick profitability checks
- Supports both positive (revenue) and negative (refunds) amounts
- Indexes on frequently filtered fields

---

### 1.4 Schema Relationships Diagram

```
Product (Phase 1)
  ├─ id (PK)
  ├─ sku
  ├─ name
  ├─ isParent
  ├─ parentId (FK to Product)
  └─ children (relation to Product)

Order (Phase 2)
  ├─ id (PK)
  ├─ amazonOrderId (UNIQUE)
  ├─ purchaseDate
  ├─ status
  ├─ fulfillmentChannel
  ├─ totalAmount
  ├─ items (relation to OrderItem)
  └─ financialTransactions (relation to FinancialTransaction)

OrderItem (Phase 2)
  ├─ id (PK)
  ├─ amazonOrderItemId (UNIQUE)
  ├─ orderId (FK to Order)
  ├─ productId (FK to Product) ← Links to Phase 1
  ├─ sellerSku
  ├─ quantity
  ├─ itemPrice
  └─ fulfillmentStatus

FinancialTransaction (Phase 2)
  ├─ id (PK)
  ├─ amazonTransactionId (UNIQUE)
  ├─ orderId (FK to Order)
  ├─ transactionType
  ├─ amount
  ├─ amazonFee
  ├─ fbaFee
  └─ netRevenue
```

---

## 2. Amazon Orders Sync Engine Service

### 2.1 Service Architecture

**File:** `apps/api/src/services/amazon-orders.service.ts`

```typescript
export class AmazonOrdersService {
  // Constructor
  constructor(
    private amazonSpApi: AmazonSpApi,
    private prisma: PrismaClient,
    private logger: Logger
  )

  // Main Entry Points
  async syncAllOrders(options: SyncOptions): Promise<SyncResult>
  async syncNewOrders(since: Date): Promise<SyncResult>
  async syncOrderById(amazonOrderId: string): Promise<Order>
  
  // Order Syncing
  private async fetchOrdersFromAmazon(params: FetchParams): Promise<AmazonOrder[]>
  private async processOrders(orders: AmazonOrder[]): Promise<ProcessResult>
  private async createOrUpdateOrder(amazonOrder: AmazonOrder): Promise<Order>
  private async linkOrderItemsToProducts(orderItems: OrderItem[]): Promise<void>
  
  // Financial Syncing
  async syncFinancialTransactions(orderId: string): Promise<FinancialTransaction[]>
  private async fetchFinancialData(params: FinanceParams): Promise<AmazonFinance[]>
  private async processFinancialData(data: AmazonFinance[]): Promise<void>
  
  // Utility Methods
  private async matchProductBySku(sku: string): Promise<Product | null>
  private async matchProductByAsin(asin: string): Promise<Product | null>
  private calculateNetRevenue(transaction: AmazonFinance): Decimal
  private validateOrderData(order: AmazonOrder): ValidationResult
  
  // Error Handling
  private async handleSyncError(error: Error, context: SyncContext): Promise<void>
  private async logSyncProgress(result: SyncResult): Promise<void>
}
```

---

### 2.2 Historical vs. Polling Strategy

#### **Historical Sync (Initial Setup)**

```typescript
async syncAllOrders(options: SyncOptions): Promise<SyncResult> {
  // 1. Determine date range
  const startDate = options.startDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days default
  const endDate = options.endDate || new Date();
  
  // 2. Fetch all orders in date range from Amazon
  const orders = await this.fetchOrdersFromAmazon({
    createdAfter: startDate,
    createdBefore: endDate,
    orderStatuses: ['Pending', 'Unshipped', 'Partially Shipped', 'Shipped', 'Cancelled', 'Unfulfillable']
  });
  
  // 3. Process orders in batches (100 at a time)
  const batchSize = 100;
  for (let i = 0; i < orders.length; i += batchSize) {
    const batch = orders.slice(i, i + batchSize);
    await this.processOrders(batch);
  }
  
  // 4. Fetch financial data for all orders
  for (const order of orders) {
    await this.syncFinancialTransactions(order.id);
  }
  
  // 5. Return summary
  return {
    syncId: generateSyncId(),
    status: 'SUCCESS',
    ordersProcessed: orders.length,
    startTime: new Date(),
    endTime: new Date()
  };
}
```

**Key Features:**
- Configurable date range (default: last 90 days)
- Batch processing to avoid memory issues
- Separate financial data sync
- Transaction support for data consistency

#### **Polling for New Orders (Ongoing)**

```typescript
async syncNewOrders(since: Date): Promise<SyncResult> {
  // 1. Get last sync time from database
  const lastSync = await this.getLastSyncTime();
  const syncSince = since || lastSync || new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours default
  
  // 2. Fetch only new/updated orders
  const orders = await this.fetchOrdersFromAmazon({
    createdAfter: syncSince,
    orderStatuses: ['Pending', 'Unshipped', 'Partially Shipped', 'Shipped']
  });
  
  // 3. Process new orders
  const result = await this.processOrders(orders);
  
  // 4. Update last sync time
  await this.updateLastSyncTime(new Date());
  
  return result;
}
```

**Key Features:**
- Tracks last sync time
- Only fetches new/updated orders
- Efficient for scheduled polling (e.g., every 15 minutes)
- Reduces API calls and processing time

---

### 2.3 Product Linking Strategy

```typescript
private async linkOrderItemsToProducts(orderItems: OrderItem[]): Promise<void> {
  for (const item of orderItems) {
    // Strategy 1: Match by sellerSku (most reliable)
    let product = await this.matchProductBySku(item.sellerSku);
    
    // Strategy 2: Match by ASIN (if SKU not found)
    if (!product && item.asin) {
      product = await this.matchProductByAsin(item.asin);
    }
    
    // Strategy 3: Try to find parent product if child not found
    if (!product && item.asin) {
      const parentProduct = await this.prisma.product.findFirst({
        where: {
          parentAsin: item.asin,
          isParent: true
        }
      });
      product = parentProduct;
    }
    
    // Update order item with product reference
    if (product) {
      await this.prisma.orderItem.update({
        where: { id: item.id },
        data: { productId: product.id }
      });
    } else {
      // Log unmatched item for manual review
      this.logger.warn(`Unmatched order item: SKU=${item.sellerSku}, ASIN=${item.asin}`);
    }
  }
}
```

**Matching Priority:**
1. **Seller SKU** (most reliable - exact match)
2. **ASIN** (if SKU not found)
3. **Parent ASIN** (for variations)
4. **Manual Review** (if no match found)

---

### 2.4 Financial Data Processing

```typescript
async syncFinancialTransactions(orderId: string): Promise<FinancialTransaction[]> {
  // 1. Fetch order from database
  const order = await this.prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true }
  });
  
  // 2. Fetch financial data from Amazon
  const financialData = await this.fetchFinancialData({
    amazonOrderId: order.amazonOrderId,
    transactionTypes: ['Order', 'Refund', 'FBA_Fee', 'Shipping_Fee', 'Tax']
  });
  
  // 3. Process and store financial transactions
  const transactions = [];
  for (const data of financialData) {
    const transaction = await this.prisma.financialTransaction.upsert({
      where: { amazonTransactionId: data.transactionId },
      update: {
        amount: data.amount,
        status: data.status,
        amazonMetadata: data
      },
      create: {
        amazonTransactionId: data.transactionId,
        orderId: order.id,
        transactionType: data.type,
        transactionDate: data.date,
        amount: data.amount,
        amazonFee: data.fees?.referral || 0,
        fbaFee: data.fees?.fba || 0,
        paymentServicesFee: data.fees?.paymentServices || 0,
        grossRevenue: data.grossAmount,
        netRevenue: data.netAmount,
        status: data.status,
        amazonMetadata: data
      }
    });
    transactions.push(transaction);
  }
  
  return transactions;
}
```

---

## 3. Sync API Endpoints

### 3.1 Orders Routes

**File:** `apps/api/src/routes/orders.routes.ts`

```typescript
export async function ordersRoutes(app: FastifyInstance) {
  
  // 1. Trigger Full Order Sync
  app.post<{ Body: SyncOrdersRequest }>(
    '/api/orders/sync',
    async (request, reply) => {
      // Validate seller authentication
      // Trigger background sync job
      // Return sync ID for tracking
    }
  );
  
  // 2. Trigger New Orders Sync (Polling)
  app.post<{ Body: SyncNewOrdersRequest }>(
    '/api/orders/sync/new',
    async (request, reply) => {
      // Sync only new orders since last sync
      // Return count of new orders
    }
  );
  
  // 3. Get Sync Status
  app.get<{ Params: { syncId: string } }>(
    '/api/orders/sync/:syncId',
    async (request, reply) => {
      // Return sync progress and status
    }
  );
  
  // 4. Get Orders List (with filtering)
  app.get<{ Querystring: OrdersQueryParams }>(
    '/api/orders',
    async (request, reply) => {
      // Return paginated orders
      // Support filtering by: status, date range, fulfillment channel
      // Support sorting by: date, amount, status
    }
  );
  
  // 5. Get Order Details
  app.get<{ Params: { orderId: string } }>(
    '/api/orders/:orderId',
    async (request, reply) => {
      // Return full order with items and financial data
    }
  );
  
  // 6. Get Order Items
  app.get<{ Params: { orderId: string } }>(
    '/api/orders/:orderId/items',
    async (request, reply) => {
      // Return order items with product details
    }
  );
  
  // 7. Get Financial Summary
  app.get<{ Querystring: FinancialQueryParams }>(
    '/api/orders/financial/summary',
    async (request, reply) => {
      // Return financial metrics:
      // - Total revenue
      // - Total fees
      // - Net revenue
      // - By date range, fulfillment channel, etc.
    }
  );
  
  // 8. Retry Failed Sync
  app.post<{ Params: { syncId: string } }>(
    '/api/orders/sync/:syncId/retry',
    async (request, reply) => {
      // Retry failed orders from previous sync
    }
  );
}
```

---

### 3.2 Request/Response Types

```typescript
// Sync Request
interface SyncOrdersRequest {
  startDate?: Date;        // Default: 90 days ago
  endDate?: Date;          // Default: now
  includeFinancials?: boolean; // Default: true
  batchSize?: number;      // Default: 100
}

// Orders Query Parameters
interface OrdersQueryParams {
  page?: number;           // Default: 1
  limit?: number;          // Default: 50
  status?: string[];       // Filter by status
  fulfillmentChannel?: string[]; // "AFN" or "MFN"
  startDate?: Date;        // Filter by date range
  endDate?: Date;
  sortBy?: 'date' | 'amount' | 'status'; // Default: date
  sortOrder?: 'asc' | 'desc'; // Default: desc
}

// Financial Query Parameters
interface FinancialQueryParams {
  startDate: Date;
  endDate: Date;
  groupBy?: 'day' | 'week' | 'month'; // Default: day
  fulfillmentChannel?: string;
}

// Response Types
interface OrdersResponse {
  success: boolean;
  data: Order[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

interface FinancialSummaryResponse {
  success: boolean;
  data: {
    period: { start: Date; end: Date };
    totalRevenue: Decimal;
    totalFees: Decimal;
    netRevenue: Decimal;
    byFulfillmentChannel: {
      AFN: { revenue: Decimal; fees: Decimal; net: Decimal };
      MFN: { revenue: Decimal; fees: Decimal; net: Decimal };
    };
    byDay?: Array<{ date: Date; revenue: Decimal; fees: Decimal; net: Decimal }>;
  };
}
```

---

## 4. Frontend Integration

### 4.1 Manage Orders Page

**File:** `apps/web/src/app/orders/manage/page.tsx`

```typescript
export default function ManageOrdersPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Manage Orders"
        description="View and manage all Amazon orders"
      />
      
      {/* Sync Controls */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Order Sync</h3>
            <p className="text-sm text-slate-600">Last synced: {lastSyncTime}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={syncNewOrders}>Sync New Orders</button>
            <button onClick={syncAllOrders}>Full Sync</button>
          </div>
        </div>
      </div>
      
      {/* Filters & Search */}
      <OrderFilters
        onFilterChange={handleFilterChange}
        filters={filters}
      />
      
      {/* Orders Table */}
      <OrdersTable
        orders={orders}
        loading={loading}
        pagination={pagination}
        onPageChange={handlePageChange}
        onRowClick={handleOrderClick}
      />
      
      {/* Order Details Modal */}
      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
      
      {/* Financial Summary */}
      <FinancialSummaryCard
        summary={financialSummary}
        dateRange={dateRange}
      />
    </div>
  );
}
```

---

### 4.2 Orders Table Component

**File:** `apps/web/src/components/orders/OrdersTable.tsx`

```typescript
interface OrdersTableProps {
  orders: Order[];
  loading: boolean;
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onRowClick: (order: Order) => void;
}

export default function OrdersTable({
  orders,
  loading,
  pagination,
  onPageChange,
  onRowClick
}: OrdersTableProps) {
  const columns = [
    {
      header: 'Order ID',
      accessorKey: 'amazonOrderId',
      cell: (info) => (
        <button
          onClick={() => onRowClick(info.row.original)}
          className="text-blue-600 hover:underline"
        >
          {info.getValue()}
        </button>
      )
    },
    {
      header: 'Date',
      accessorKey: 'purchaseDate',
      cell: (info) => new Date(info.getValue()).toLocaleDateString()
    },
    {
      header: 'Buyer',
      accessorKey: 'buyerName'
    },
    {
      header: 'Items',
      accessorKey: 'items',
      cell: (info) => info.getValue().length
    },
    {
      header: 'Amount',
      accessorKey: 'totalAmount',
      cell: (info) => `$${parseFloat(info.getValue()).toFixed(2)}`
    },
    {
      header: 'Channel',
      accessorKey: 'fulfillmentChannel',
      cell: (info) => (
        <span className={info.getValue() === 'AFN' ? 'bg-blue-100 px-2 py-1 rounded' : 'bg-gray-100 px-2 py-1 rounded'}>
          {info.getValue() === 'AFN' ? 'FBA' : 'FBM'}
        </span>
      )
    },
    {
      header: 'Status',
      accessorKey: 'status',
      cell: (info) => (
        <StatusBadge status={info.getValue()} />
      )
    }
  ];
  
  return (
    <div className="bg-white rounded-lg border border-slate-200">
      <DataTable
        columns={columns}
        data={orders}
        loading={loading}
        pagination={pagination}
        onPageChange={onPageChange}
      />
    </div>
  );
}
```

---

### 4.3 Order Details Modal

**File:** `apps/web/src/components/orders/OrderDetailsModal.tsx`

```typescript
interface OrderDetailsModalProps {
  order: Order;
  onClose: () => void;
}

export default function OrderDetailsModal({
  order,
  onClose
}: OrderDetailsModalProps) {
  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <div className="space-y-6">
        {/* Order Header */}
        <div className="border-b pb-4">
          <h2 className="text-2xl font-bold">{order.amazonOrderId}</h2>
          <p className="text-sm text-slate-600">
            {new Date(order.purchaseDate).toLocaleDateString()}
          </p>
        </div>
        
        {/* Buyer Information */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-slate-600">Buyer</p>
            <p className="font-semibold">{order.buyerName}</p>
          </div>
          <div>
            <p className="text-sm text-slate-600">Email</p>
            <p className="font-semibold">{order.buyerEmail}</p>
          </div>
        </div>
        
        {/* Shipping Address */}
        <div>
          <p className="text-sm text-slate-600 mb-2">Shipping Address</p>
          <div className="bg-slate-50 p-3 rounded text-sm">
            {order.shippingAddress.street1}<br/>
            {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}<br/>
            {order.shippingAddress.country}
          </div>
        </div>
        
        {/* Order Items */}
        <div>
          <h3 className="font-semibold mb-3">Items</h3>
          <OrderItemsTable items={order.items} />
        </div>
        
        {/* Financial Summary */}
        <div className="bg-slate-50 p-4 rounded">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-slate-600">Subtotal</p>
              <p className="text-lg font-bold">${order.items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Fees</p>
              <p className="text-lg font-bold text-red-600">-${calculateTotalFees(order).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Net Revenue</p>
              <p className="text-lg font-bold text-green-600">${calculateNetRevenue(order).toFixed(2)}</p>
            </div>
          </div>
        </div>
        
        {/* Fulfillment Status */}
        <div>
          <p className="text-sm text-slate-600 mb-2">Fulfillment</p>
          <div className="space-y-2">
            <p><strong>Channel:</strong> {order.fulfillmentChannel === 'AFN' ? 'FBA' : 'FBM'}</p>
            <p><strong>Status:</strong> <StatusBadge status={order.status} /></p>
            {order.trackingNumber && (
              <p><strong>Tracking:</strong> {order.trackingNumber}</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
```

---

### 4.4 Financial Summary Card

**File:** `apps/web/src/components/orders/FinancialSummaryCard.tsx`

```typescript
interface FinancialSummaryCardProps {
  summary: FinancialSummary;
  dateRange: { start: Date; end: Date };
}

export default function FinancialSummaryCard({
  summary,
  dateRange
}: FinancialSummaryCardProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {/* Total Revenue */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <p className="text-sm text-slate-600 uppercase tracking-wide">Total Revenue</p>
        <p className="text-3xl font-bold text-slate-900 mt-2">
          ${summary.totalRevenue.toFixed(2)}
        </p>
        <p className="text-xs text-slate-500 mt-1">
          {summary.orderCount} orders
        </p>
      </div>
      
      {/* Total Fees */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <p className="text-sm text-slate-600 uppercase tracking-wide">Total Fees</p>
        <p className="text-3xl font-bold text-red-600 mt-2">

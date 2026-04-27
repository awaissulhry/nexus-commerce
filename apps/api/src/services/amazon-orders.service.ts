import prisma from "../db.js";

interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  LastUpdateDate?: string;
  OrderStatus: string;
  FulfillmentChannel: string;
  BuyerInfo: {
    BuyerName: string;
    BuyerEmail?: string;
    BuyerPhoneNumber?: string;
  };
  ShippingAddress: {
    AddressLine1?: string;
    AddressLine2?: string;
    City?: string;
    StateOrRegion?: string;
    PostalCode?: string;
    CountryCode?: string;
  };
  OrderTotal: {
    Amount: string;
    CurrencyCode: string;
  };
  ShipmentServiceLevelCategory?: string;
}

interface AmazonOrderItem {
  OrderItemId: string;
  ASIN: string;
  SellerSKU: string;
  Title: string;
  QuantityOrdered: number;
  ItemPrice?: {
    Amount: string;
    CurrencyCode: string;
  };
  ItemTax?: {
    Amount: string;
    CurrencyCode: string;
  };
  ShippingPrice?: {
    Amount: string;
    CurrencyCode: string;
  };
  ShippingTax?: {
    Amount: string;
    CurrencyCode: string;
  };
  FulfillmentChannel?: string;
}

interface AmazonFinancialTransaction {
  TransactionId: string;
  TransactionType: string;
  TransactionDate: string;
  Amount: string;
  CurrencyCode: string;
  AmazonFee?: string;
  FBAFee?: string;
  PaymentServicesFee?: string;
  OtherFees?: string;
  GrossRevenue: string;
  NetRevenue: string;
}

interface SyncResult {
  syncId: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  ordersProcessed: number;
  ordersSuccessful: number;
  ordersFailed: number;
  itemsProcessed: number;
  itemsSuccessful: number;
  itemsFailed: number;
  errors: Array<{ orderId: string; error: string }>;
  startedAt: Date;
  completedAt: Date;
}

export class AmazonOrdersService {
  private stats = {
    ordersProcessed: 0,
    ordersSuccessful: 0,
    ordersFailed: 0,
    itemsProcessed: 0,
    itemsSuccessful: 0,
    itemsFailed: 0,
  };

  private errors: Array<{ orderId: string; error: string }> = [];

  constructor() {
    this.resetStats();
  }

  private resetStats() {
    this.stats = {
      ordersProcessed: 0,
      ordersSuccessful: 0,
      ordersFailed: 0,
      itemsProcessed: 0,
      itemsSuccessful: 0,
      itemsFailed: 0,
    };
    this.errors = [];
  }

  /**
   * Sync all orders from Amazon (historical sync)
   * Fetches orders from the last 90 days
   */
  async syncAllOrders(options?: {
    daysBack?: number;
    limit?: number;
  }): Promise<SyncResult> {
    const startedAt = new Date();
    this.resetStats();

    try {
      const daysBack = options?.daysBack || 90;
      const limit = options?.limit || 100;

      // In production, this would call Amazon SP-API OrdersV0
      // For now, we'll return a template for the implementation
      console.log(
        `Fetching orders from last ${daysBack} days (limit: ${limit})`
      );

      // TODO: Call Amazon SP-API
      // const orders = await this.fetchOrdersFromAmazon(daysBack, limit);
      // await this.processOrders(orders);

      return this.buildSyncResult(startedAt, "SUCCESS");
    } catch (error) {
      console.error("Error syncing all orders:", error);
      return this.buildSyncResult(startedAt, "FAILED");
    }
  }

  /**
   * Sync new orders since last sync (polling sync)
   * Fetches orders updated since the specified timestamp
   */
  async syncNewOrders(since: Date): Promise<SyncResult> {
    const startedAt = new Date();
    this.resetStats();

    try {
      console.log(`Fetching orders updated since ${since.toISOString()}`);

      // TODO: Call Amazon SP-API with CreatedAfter filter
      // const orders = await this.fetchOrdersFromAmazon(since);
      // await this.processOrders(orders);

      return this.buildSyncResult(startedAt, "SUCCESS");
    } catch (error) {
      console.error("Error syncing new orders:", error);
      return this.buildSyncResult(startedAt, "FAILED");
    }
  }

  /**
   * Sync a single order by Amazon Order ID
   */
  async syncOrderById(amazonOrderId: string): Promise<SyncResult> {
    const startedAt = new Date();
    this.resetStats();

    try {
      console.log(`Fetching order ${amazonOrderId}`);

      // TODO: Call Amazon SP-API to get single order
      // const order = await this.fetchOrderFromAmazon(amazonOrderId);
      // await this.processOrder(order);

      return this.buildSyncResult(startedAt, "SUCCESS");
    } catch (error) {
      console.error(`Error syncing order ${amazonOrderId}:`, error);
      return this.buildSyncResult(startedAt, "FAILED");
    }
  }

  /**
   * Process a single order and its items
   */
  private async processOrder(order: AmazonOrder): Promise<void> {
    this.stats.ordersProcessed++;

    try {
      // Link to existing product or create placeholder
      await this.linkOrderToProducts(order);

      // Save order to database
      await (prisma.order as any).upsert({
        where: { amazonOrderId: order.AmazonOrderId },
        update: {
          lastUpdateDate: order.LastUpdateDate
            ? new Date(order.LastUpdateDate)
            : undefined,
          status: order.OrderStatus,
          fulfillmentChannel: order.FulfillmentChannel,
          buyerName: order.BuyerInfo.BuyerName,
          buyerEmail: order.BuyerInfo.BuyerEmail,
          buyerPhone: order.BuyerInfo.BuyerPhoneNumber,
          shippingAddress: order.ShippingAddress,
          totalAmount: parseFloat(order.OrderTotal.Amount),
          currencyCode: order.OrderTotal.CurrencyCode,
          amazonMetadata: order as any,
        },
        create: {
          amazonOrderId: order.AmazonOrderId,
          purchaseDate: new Date(order.PurchaseDate),
          lastUpdateDate: order.LastUpdateDate
            ? new Date(order.LastUpdateDate)
            : undefined,
          status: order.OrderStatus,
          fulfillmentChannel: order.FulfillmentChannel,
          buyerName: order.BuyerInfo.BuyerName,
          buyerEmail: order.BuyerInfo.BuyerEmail,
          buyerPhone: order.BuyerInfo.BuyerPhoneNumber,
          shippingAddress: order.ShippingAddress,
          totalAmount: parseFloat(order.OrderTotal.Amount),
          currencyCode: order.OrderTotal.CurrencyCode,
          amazonMetadata: order as any,
        },
      });

      this.stats.ordersSuccessful++;
    } catch (error) {
      this.stats.ordersFailed++;
      this.errors.push({
        orderId: order.AmazonOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Link order items to products using SKU/ASIN matching
   * Priority: SKU → ASIN → Parent ASIN → Manual review
   */
  private async linkOrderToProducts(order: AmazonOrder): Promise<AmazonOrder> {
    // TODO: Implement product linking logic
    // This would:
    // 1. Try to match by sellerSku
    // 2. Fall back to ASIN matching
    // 3. Fall back to parent ASIN matching
    // 4. Mark for manual review if no match found

    return order;
  }

  /**
   * Process order items and link to products
   */
  private async processOrderItems(
    orderId: string,
    items: AmazonOrderItem[]
  ): Promise<void> {
    for (const item of items) {
      this.stats.itemsProcessed++;

      try {
        // Find product by SKU or ASIN
        const product = await this.findProductBySkuOrAsin(
          item.SellerSKU,
          item.ASIN
        );

        const itemPrice = item.ItemPrice
          ? parseFloat(item.ItemPrice.Amount)
          : 0;
        const itemTax = item.ItemTax ? parseFloat(item.ItemTax.Amount) : 0;
        const shippingPrice = item.ShippingPrice
          ? parseFloat(item.ShippingPrice.Amount)
          : 0;
        const shippingTax = item.ShippingTax
          ? parseFloat(item.ShippingTax.Amount)
          : 0;
        const subtotal = itemPrice * item.QuantityOrdered;
        const totalWithShipping = subtotal + shippingPrice;

        // Save order item
        await (prisma.orderItem as any).upsert({
          where: { id: item.OrderItemId },
          update: {
            productId: product?.id,
            title: item.Title,
            quantity: item.QuantityOrdered,
            itemPrice,
            itemTax,
            shippingPrice,
            shippingTax,
            subtotal,
            totalWithShipping,
            fulfillmentStatus: item.FulfillmentChannel || "Pending",
            amazonMetadata: item as any,
          },
          create: {
            id: item.OrderItemId,
            amazonOrderItemId: item.OrderItemId,
            orderId,
            productId: product?.id,
            sellerSku: item.SellerSKU,
            asin: item.ASIN,
            title: item.Title,
            quantity: item.QuantityOrdered,
            itemPrice,
            itemTax,
            shippingPrice,
            shippingTax,
            subtotal,
            totalWithShipping,
            fulfillmentStatus: item.FulfillmentChannel || "Pending",
            amazonMetadata: item as any,
          },
        });

        this.stats.itemsSuccessful++;
      } catch (error) {
        this.stats.itemsFailed++;
        console.error(`Error processing order item ${item.OrderItemId}:`, error);
      }
    }
  }

  /**
   * Find product by SKU or ASIN with priority matching
   */
  private async findProductBySkuOrAsin(
    sku: string,
    asin?: string
  ): Promise<any | null> {
    // Priority 1: Match by SKU
    let product = await (prisma.product as any).findUnique({
      where: { sku },
    });

    if (product) return product;

    // Priority 2: Match by ASIN
    if (asin) {
      product = await (prisma.product as any).findFirst({
        where: { amazonAsin: asin },
      });

      if (product) return product;

      // Priority 3: Match by parent ASIN
      product = await (prisma.product as any).findFirst({
        where: { parentAsin: asin },
      });

      if (product) return product;
    }

    // No match found - return null for manual review
    return null;
  }

  /**
   * Process financial transactions for an order
   */
  private async processFinancialTransactions(
    orderId: string,
    transactions: AmazonFinancialTransaction[]
  ): Promise<void> {
    for (const transaction of transactions) {
      try {
        await (prisma as any).financialTransaction.upsert({
          where: { amazonTransactionId: transaction.TransactionId },
          update: {
            transactionType: transaction.TransactionType,
            transactionDate: new Date(transaction.TransactionDate),
            amount: parseFloat(transaction.Amount),
            currencyCode: transaction.CurrencyCode,
            amazonFee: transaction.AmazonFee
              ? parseFloat(transaction.AmazonFee)
              : 0,
            fbaFee: transaction.FBAFee ? parseFloat(transaction.FBAFee) : 0,
            paymentServicesFee: transaction.PaymentServicesFee
              ? parseFloat(transaction.PaymentServicesFee)
              : 0,
            otherFees: transaction.OtherFees
              ? parseFloat(transaction.OtherFees)
              : 0,
            grossRevenue: parseFloat(transaction.GrossRevenue),
            netRevenue: parseFloat(transaction.NetRevenue),
            status: "Completed",
            amazonMetadata: transaction as any,
          },
          create: {
            amazonTransactionId: transaction.TransactionId,
            orderId,
            transactionType: transaction.TransactionType,
            transactionDate: new Date(transaction.TransactionDate),
            amount: parseFloat(transaction.Amount),
            currencyCode: transaction.CurrencyCode,
            amazonFee: transaction.AmazonFee
              ? parseFloat(transaction.AmazonFee)
              : 0,
            fbaFee: transaction.FBAFee ? parseFloat(transaction.FBAFee) : 0,
            paymentServicesFee: transaction.PaymentServicesFee
              ? parseFloat(transaction.PaymentServicesFee)
              : 0,
            otherFees: transaction.OtherFees
              ? parseFloat(transaction.OtherFees)
              : 0,
            grossRevenue: parseFloat(transaction.GrossRevenue),
            netRevenue: parseFloat(transaction.NetRevenue),
            status: "Completed",
            amazonMetadata: transaction as any,
          },
        });
      } catch (error) {
        console.error(
          `Error processing financial transaction ${transaction.TransactionId}:`,
          error
        );
      }
    }
  }

  /**
   * Get sync status by sync ID
   */
  async getSyncStatus(syncId: string): Promise<any> {
    // TODO: Implement sync status tracking
    // This would query a SyncJob or similar table
    return {
      syncId,
      status: "COMPLETED",
      progress: 100,
    };
  }

  /**
   * Build sync result object
   */
  private buildSyncResult(
    startedAt: Date,
    status: "SUCCESS" | "FAILED" | "PARTIAL"
  ): SyncResult {
    const completedAt = new Date();

    return {
      syncId: `sync_${Date.now()}`,
      status,
      ordersProcessed: this.stats.ordersProcessed,
      ordersSuccessful: this.stats.ordersSuccessful,
      ordersFailed: this.stats.ordersFailed,
      itemsProcessed: this.stats.itemsProcessed,
      itemsSuccessful: this.stats.itemsSuccessful,
      itemsFailed: this.stats.itemsFailed,
      errors: this.errors,
      startedAt,
      completedAt,
    };
  }

  /**
   * Validate order data
   */
  validateOrder(order: AmazonOrder): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!order.AmazonOrderId) errors.push("Missing AmazonOrderId");
    if (!order.PurchaseDate) errors.push("Missing PurchaseDate");
    if (!order.OrderStatus) errors.push("Missing OrderStatus");
    if (!order.FulfillmentChannel) errors.push("Missing FulfillmentChannel");
    if (!order.BuyerInfo?.BuyerName) errors.push("Missing BuyerName");
    if (!order.OrderTotal?.Amount) errors.push("Missing OrderTotal.Amount");

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

import { prisma } from "@nexus/database";
import ManageOrdersClient from "@/components/orders/ManageOrdersClient";

export interface OrderWithDetails {
  id: string;
  salesChannel: string;
  amazonOrderId: string | null;
  ebayOrderId: string | null;
  purchaseDate: Date;
  lastUpdateDate: Date | null;
  status: string;
  fulfillmentChannel: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  shippingAddress: any;
  totalAmount: number;
  currencyCode: string;
  shipmentDate: Date | null;
  deliveryDate: Date | null;
  trackingNumber: string | null;
  carrier: string | null;
  amazonMetadata: any;
  ebayMetadata: any;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    amazonOrderItemId: string | null;
    ebayLineItemId: string | null;
    orderId: string;
    productId: string | null;
    sellerSku: string;
    asin: string | null;
    ebayItemId: string | null;
    title: string;
    quantity: number;
    itemPrice: number;
    itemTax: number;
    shippingPrice: number;
    shippingTax: number;
    subtotal: number;
    totalWithShipping: number;
    fulfillmentStatus: string;
    amazonMetadata: any;
    ebayMetadata: any;
    createdAt: Date;
    updatedAt: Date;
    product: {
      id: string;
      sku: string;
      name: string;
      basePrice: number;
    } | null;
  }>;
  financialTransactions: Array<{
    id: string;
    amazonTransactionId: string | null;
    ebayTransactionId: string | null;
    orderId: string;
    transactionType: string;
    transactionDate: Date;
    amount: number;
    currencyCode: string;
    amazonFee: number;
    fbaFee: number;
    paymentServicesFee: number;
    ebayFee: number;
    paypalFee: number;
    otherFees: number;
    grossRevenue: number;
    netRevenue: number;
    status: string;
    amazonMetadata: any;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

async function getOrdersData(): Promise<OrderWithDetails[]> {
  try {
    const orders = await (prisma.order as any).findMany({
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                name: true,
                basePrice: true,
              },
            },
          },
        },
        financialTransactions: true,
      },
      orderBy: {
        purchaseDate: "desc",
      },
      take: 50, // Initial load
    });

    return orders.map((order: any) => ({
      ...order,
      salesChannel: order.salesChannel || "AMAZON", // Default to AMAZON for backward compatibility
      totalAmount: parseFloat(order.totalAmount),
      items: order.items.map((item: any) => ({
        ...item,
        itemPrice: parseFloat(item.itemPrice),
        itemTax: parseFloat(item.itemTax),
        shippingPrice: parseFloat(item.shippingPrice),
        shippingTax: parseFloat(item.shippingTax),
        subtotal: parseFloat(item.subtotal),
        totalWithShipping: parseFloat(item.totalWithShipping),
        product: item.product ? {
          ...item.product,
          basePrice: parseFloat(item.product.basePrice),
        } : null,
      })),
      financialTransactions: order.financialTransactions.map((txn: any) => ({
        ...txn,
        amount: parseFloat(txn.amount),
        amazonFee: parseFloat(txn.amazonFee || 0),
        fbaFee: parseFloat(txn.fbaFee || 0),
        ebayFee: parseFloat(txn.ebayFee || 0),
        paypalFee: parseFloat(txn.paypalFee || 0),
        paymentServicesFee: parseFloat(txn.paymentServicesFee || 0),
        otherFees: parseFloat(txn.otherFees || 0),
        grossRevenue: parseFloat(txn.grossRevenue || 0),
        netRevenue: parseFloat(txn.netRevenue || 0),
      })),
    }));
  } catch (error) {
    console.error("Error fetching orders:", error);
    return [];
  }
}

export default async function ManageOrdersPage() {
  const orders = await getOrdersData();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Manage Orders</h1>
        <p className="text-slate-600 mt-2">
          View and manage cross-channel orders, items, and financial transactions
        </p>
      </div>

      <ManageOrdersClient initialOrders={orders} />
    </div>
  );
}

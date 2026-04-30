import { prisma } from "@nexus/database";
import PageHeader from "@/components/layout/PageHeader";
import PricingClient from "./PricingClient";

export const dynamic = "force-dynamic";

export interface PricingRow {
  id: string;
  sku: string;
  name: string;
  asin: string | null;
  imageUrl: string | null;
  basePrice: number;
  costPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  buyBoxPrice: number | null;
  competitorPrice: number | null;
  fulfillment: string | null;
  stock: number;
  margin: number | null;
}

async function getPricingData(): Promise<PricingRow[]> {
  try {
  const products = await prisma.product.findMany({
    include: {
      images: { take: 1, orderBy: { type: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return products.map((p: any): PricingRow => {
    const mainImage = p.images?.[0];
    const cost = p.costPrice ? Number(p.costPrice) : null;
    const price = Number(p.basePrice);
    const margin = cost !== null && cost > 0 ? ((price - cost) / price) * 100 : null;

    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      asin: p.amazonAsin ?? null,
      imageUrl: mainImage?.url ?? null,
      basePrice: price,
      costPrice: cost,
      minPrice: p.minPrice ? Number(p.minPrice) : null,
      maxPrice: p.maxPrice ? Number(p.maxPrice) : null,
      buyBoxPrice: p.buyBoxPrice ? Number(p.buyBoxPrice) : null,
      competitorPrice: p.competitorPrice ? Number(p.competitorPrice) : null,
      fulfillment: p.fulfillmentMethod ?? null,
      stock: p.totalStock,
      margin,
    };
  });
  } catch (err: any) {
    console.error('[PRICING] Prisma error', {
      message: err.message,
      code: err.code,
      meta: err.meta,
    });
    return [];
  }
}

export default async function PricingPage() {
  const data = await getPricingData();

  return (
    <div>
      <PageHeader
        title="Manage Pricing"
        subtitle={`${data.length} product${data.length !== 1 ? "s" : ""}`}
        breadcrumbs={[
          { label: "Pricing" },
          { label: "Manage Pricing" },
        ]}
      />

      <PricingClient data={data} />
    </div>
  );
}

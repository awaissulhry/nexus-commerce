import { prisma } from "@nexus/database";
import { notFound } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import ProductEditForm from "@/components/catalog/ProductEditForm";

async function getProduct(id: string) {
  try {
    const product = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        name: true,
        basePrice: true,
        totalStock: true,
        productType: true,
        categoryAttributes: true,
      },
    });

    if (!product) return null;

    // Convert Decimal to number for frontend
    return {
      ...product,
      basePrice: product.basePrice.toNumber(),
    };
  } catch (error) {
    console.error("Error fetching product:", error);
    return null;
  }
}

export default async function EditProductPage({
  params,
}: {
  params: { id: string };
}) {
  const product = await getProduct(params.id);

  if (!product) {
    notFound();
  }

  return (
    <div>
      <PageHeader
        title="Edit Product"
        breadcrumbs={[
          { label: "Dashboard", href: "/" },
          { label: "Catalog", href: "/catalog" },
          { label: "Edit", href: `/catalog/edit/${product.id}` },
        ]}
      />

      <div className="p-6">
        <div className="max-w-2xl">
          <ProductEditForm product={product} />
        </div>
      </div>
    </div>
  );
}

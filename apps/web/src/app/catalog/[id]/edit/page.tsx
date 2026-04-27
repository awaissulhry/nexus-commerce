import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import MatrixEditor from './MatrixEditor'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditProductPage({ params }: PageProps) {
  const { id } = await params

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      images: true,
      children: true,  // Include full children data
    },
  })

  if (!product) {
    notFound()
  }

  const childrenCount = product.children?.length || 0

  // Serialize the product data to ensure Next.js can pass it to client components
  const serializedProduct = {
    id: product.id,
    sku: product.sku,
    name: product.name,
    basePrice: product.basePrice?.toString() || '0',
    totalStock: product.totalStock,
    isParent: product.isParent,
    categoryAttributes: product.categoryAttributes,
    // CRITICAL: Include the children array with serialized data
    children: product.children ? product.children.map(child => ({
      id: child.id,
      sku: child.sku,
      name: child.name,
      basePrice: child.basePrice?.toString() || '0',
      totalStock: child.totalStock,
      categoryAttributes: child.categoryAttributes,
    })) : [],
    images: product.images || [],
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/catalog/${product.id}`}
          className="text-gray-500 hover:text-gray-700 transition-colors"
        >
          ← Back to Product
        </Link>
        <span className="text-gray-300">|</span>
        <Link
          href="/inventory"
          className="text-gray-500 hover:text-gray-700 transition-colors"
        >
          Inventory
        </Link>
      </div>

      <MatrixEditor
        initialProduct={serializedProduct}
        isParent={product.isParent}
        childrenCount={childrenCount}
      />
    </div>
  )
}

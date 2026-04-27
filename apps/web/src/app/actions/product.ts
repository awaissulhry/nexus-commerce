'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function createProduct(formData: FormData) {
  try {
    const sku = formData.get('sku') as string
    const name = formData.get('name') as string
    const basePrice = formData.get('basePrice') as string
    const totalStock = formData.get('totalStock') as string

    // Validation
    if (!sku || !name || !basePrice || !totalStock) {
      throw new Error('All fields are required')
    }

    // Create product in database
    await prisma.product.create({
      data: {
        sku: sku.trim(),
        name: name.trim(),
        basePrice: parseFloat(basePrice),
        totalStock: parseInt(totalStock, 10),
      },
    })

    // Revalidate the catalog page to show the new product
    revalidatePath('/catalog')

    // Redirect back to catalog
    redirect('/catalog')
  } catch (error) {
    console.error('Error creating product:', error)
    throw error
  }
}

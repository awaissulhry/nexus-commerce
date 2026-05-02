'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'

export async function linkListingToProduct(listingId: string, productId: string) {
  try {
    // Validate inputs
    if (!listingId || !productId) {
      throw new Error('Listing ID and Product ID are required')
    }

    // Update the listing to link it to the product
    await prisma.listing.update({
      where: {
        id: listingId,
      },
      data: {
        productId: productId,
      },
    })

    // Revalidate the listings page to show the updated state
    revalidatePath('/inventory')
    revalidatePath('/products')

    return { success: true, message: 'Listing linked successfully' }
  } catch (error) {
    console.error('Error linking listing:', error)
    throw error
  }
}

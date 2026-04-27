'use server'

const API_BASE = process.env.SYNC_API_URL || 'http://localhost:3001'

export async function generateAIListing(productId: string) {
  try {
    const res = await fetch(`${API_BASE}/ai/generate-listing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId }),
    })

    if (!res.ok) {
      const body = await res.text()
      return { success: false, error: `Generation failed (${res.status}): ${body}` }
    }

    const data = await res.json()
    return {
      success: true,
      data: data.data, // { ebayTitle, categoryId, itemSpecifics, htmlDescription }
      product: data.product,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to connect to AI API' }
  }
}

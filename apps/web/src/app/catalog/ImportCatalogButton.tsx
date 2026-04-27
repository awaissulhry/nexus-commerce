'use client'

import { useState } from 'react'
import { logger } from '@/lib/logger'

export default function ImportCatalogButton() {
  const [isLoading, setIsLoading] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const handleImportCatalog = async () => {
    setIsLoading(true)
    setStatus(null)

    try {
      logger.info('Starting Amazon EU catalog import (The Vacuum)...')

      const response = await fetch('/api/inbound/sync-catalog', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to import catalog: ${response.statusText}`)
      }

      const data = await response.json()

      logger.info('Catalog import completed', data.results)

      setStatus({
        type: 'success',
        message: `✓ Successfully imported ${data.results.productsCreated} products with ${data.results.listingsCreated} listings and ${data.results.offersCreated} offers!`,
      })

      // Refresh the page after 2 seconds to show new products
      setTimeout(() => {
        window.location.reload()
      }, 2000)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import catalog'
      logger.error('Catalog import failed', { error: errorMsg })
      setStatus({
        type: 'error',
        message: `✗ ${errorMsg}`,
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={handleImportCatalog}
        disabled={isLoading}
        className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed transition-all font-medium flex items-center gap-2"
      >
        {isLoading ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            Vacuuming Amazon EU Catalog...
          </>
        ) : (
          <>
            🌍 Import Live Catalog
          </>
        )}
      </button>

      {status && (
        <div
          className={`p-4 rounded-lg border ${
            status.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <p className="text-sm font-medium">{status.message}</p>
        </div>
      )}
    </div>
  )
}

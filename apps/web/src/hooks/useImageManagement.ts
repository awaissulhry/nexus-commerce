'use client'

import { useState, useCallback } from 'react'

interface ImageData {
  id: string
  url: string
  alt?: string
  type: 'MAIN' | 'ALT' | 'LIFESTYLE' | 'SWATCH'
  dominantColor?: string
  colorConfidence?: number
  colorOverride?: string
  isHero: boolean
  assignedVariants: string[]
  uploadStatus: 'PENDING' | 'UPLOADING' | 'SUCCESS' | 'FAILED'
  uploadError?: string
}

interface UseImageManagementReturn {
  images: ImageData[]
  isLoading: boolean
  error: string | null
  uploadImage: (file: File, type: string) => Promise<void>
  setHeroImage: (imageId: string) => Promise<void>
  deleteImage: (imageId: string) => Promise<void>
  autoAssignImages: () => Promise<void>
  updateColorOverride: (imageId: string, color: string) => Promise<void>
  fetchImages: (productId: string) => Promise<void>
}

export function useImageManagement(productId: string): UseImageManagementReturn {
  const [images, setImages] = useState<ImageData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch all images for product
  const fetchImages = useCallback(
    async (id: string) => {
      try {
        setIsLoading(true)
        setError(null)

        const response = await fetch(`/api/images/${id}`)
        if (!response.ok) {
          throw new Error('Failed to fetch images')
        }

        const data = await response.json()
        setImages(data.images || [])
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setError(message)
        console.error('Fetch images error:', err)
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  // Upload image
  const uploadImage = useCallback(
    async (file: File, type: string) => {
      try {
        setIsLoading(true)
        setError(null)

        // Create FormData for file upload
        const formData = new FormData()
        formData.append('file', file)
        formData.append('productId', productId)
        formData.append('type', type)
        formData.append('alt', file.name)

        // For now, we'll use a simple approach - convert file to data URL
        const reader = new FileReader()
        reader.onload = async (e) => {
          const imageUrl = e.target?.result as string

          const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              productId,
              imageUrl,
              type,
              alt: file.name,
            }),
          })

          if (!response.ok) {
            throw new Error('Upload failed')
          }

          const data = await response.json()
          setImages((prev) => [...prev, data.image])
        }

        reader.readAsDataURL(file)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setError(message)
        console.error('Upload error:', err)
      } finally {
        setIsLoading(false)
      }
    },
    [productId]
  )

  // Set hero image
  const setHeroImage = useCallback(
    async (imageId: string) => {
      try {
        setIsLoading(true)
        setError(null)

        const response = await fetch(`/api/images/${imageId}/hero`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ productId }),
        })

        if (!response.ok) {
          throw new Error('Failed to set hero image')
        }

        const _data = await response.json()

        // Update local state
        setImages((prev) =>
          prev.map((img) => ({
            ...img,
            isHero: img.id === imageId,
          }))
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to set hero'
        setError(message)
        console.error('Set hero error:', err)
      } finally {
        setIsLoading(false)
      }
    },
    [productId]
  )

  // Delete image
  const deleteImage = useCallback(
    async (imageId: string) => {
      try {
        setIsLoading(true)
        setError(null)

        const response = await fetch(`/api/images/${imageId}`, {
          method: 'DELETE',
        })

        if (!response.ok) {
          throw new Error('Failed to delete image')
        }

        // Update local state
        setImages((prev) => prev.filter((img) => img.id !== imageId))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed'
        setError(message)
        console.error('Delete error:', err)
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  // Auto-assign images to variants
  const autoAssignImages = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)

      const response = await fetch(`/api/images/${productId}/auto-assign`, {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('Auto-assign failed')
      }

      const data = await response.json()
      console.log('Auto-assign result:', data)

      // Refresh images
      await fetchImages(productId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Auto-assign failed'
      setError(message)
      console.error('Auto-assign error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [productId, fetchImages])

  // Update color override
  const updateColorOverride = useCallback(
    async (imageId: string, color: string) => {
      try {
        setIsLoading(true)
        setError(null)

        const response = await fetch(`/api/images/${imageId}/color`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ colorOverride: color }),
        })

        if (!response.ok) {
          throw new Error('Failed to update color')
        }

        const _data = await response.json()

        // Update local state
        setImages((prev) =>
          prev.map((img) =>
            img.id === imageId ? { ...img, colorOverride: color } : img
          )
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Update failed'
        setError(message)
        console.error('Update color error:', err)
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  return {
    images,
    isLoading,
    error,
    uploadImage,
    setHeroImage,
    deleteImage,
    autoAssignImages,
    updateColorOverride,
    fetchImages,
  }
}

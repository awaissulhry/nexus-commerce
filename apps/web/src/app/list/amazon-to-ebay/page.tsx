import React from 'react';
import { AmazonToEbayClient } from './AmazonToEbayClient';

interface Product {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;
  images?: Array<{ url: string }>;
  ebayItemId?: string;
}

async function fetchProducts(): Promise<Product[]> {
  try {
    const response = await fetch('http://localhost:3001/api/products', {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Failed to fetch products');
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('Error fetching products:', error);
    return [];
  }
}

async function fetchPublished(): Promise<Product[]> {
  try {
    const response = await fetch('http://localhost:3001/api/listings/published', {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Failed to fetch published listings');
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('Error fetching published listings:', error);
    return [];
  }
}

export default async function AmazonToEbayPage() {
  const [products, published] = await Promise.all([
    fetchProducts(),
    fetchPublished(),
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <AmazonToEbayClient
        initialProducts={products}
        initialPublished={published}
      />
    </div>
  );
}

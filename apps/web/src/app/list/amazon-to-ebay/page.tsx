import React from 'react';
import { AmazonToEbayClient } from './AmazonToEbayClient';
import { prisma } from '@nexus/database';

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
    const products = await prisma.product.findMany({
      where: {
        status: 'ACTIVE',
      },
      select: {
        id: true,
        sku: true,
        name: true,
        basePrice: true,
        totalStock: true,
        ebayItemId: true,
        images: {
          select: {
            url: true,
          },
        },
      },
      take: 100,
    });

    return products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      basePrice: Number(p.basePrice),
      totalStock: p.totalStock,
      ebayItemId: p.ebayItemId || undefined,
      images: p.images,
    }));
  } catch (error) {
    console.error('Error fetching products:', error);
    return [];
  }
}

async function fetchPublished(): Promise<Product[]> {
  try {
    const listings = await prisma.channelListing.findMany({
      where: {
        channel: 'EBAY',
        isPublished: true,
      },
      select: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            basePrice: true,
            totalStock: true,
            ebayItemId: true,
            images: {
              select: {
                url: true,
              },
            },
          },
        },
      },
      take: 100,
    });

    return listings
      .map((l) => l.product)
      .filter((p) => p !== null)
      .map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        basePrice: Number(p.basePrice),
        totalStock: p.totalStock,
        ebayItemId: p.ebayItemId || undefined,
        images: p.images,
      }));
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

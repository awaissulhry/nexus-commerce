/**
 * SKU Generation Helper
 * Converts option values to slugified SKU components
 */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

export interface OptionType {
  id: string;
  name: string;
  values: string[];
}

export interface GeneratedVariation {
  sku: string;
  name: string;
  optionValues: Record<string, string>;
}

/**
 * Generate all possible SKU combinations from option types
 * @param parentSku - Parent product SKU (e.g., "JACKET")
 * @param optionTypes - Array of option types with their values
 * @returns Array of generated variations with SKUs
 */
export function generateVariationMatrix(
  parentSku: string,
  optionTypes: OptionType[]
): GeneratedVariation[] {
  if (optionTypes.length === 0) {
    return [];
  }

  // Filter out empty option types
  const validOptions = optionTypes.filter(
    (opt) => opt.values && opt.values.length > 0
  );

  if (validOptions.length === 0) {
    return [];
  }

  const variations: GeneratedVariation[] = [];

  // Generate cartesian product of all option values
  function cartesianProduct(
    options: OptionType[],
    index: number = 0,
    current: Record<string, string> = {}
  ): void {
    if (index === options.length) {
      // Build SKU from parent + all option values
      const skuParts = [parentSku];
      const nameParts = [];

      for (const option of options) {
        const value = current[option.id];
        if (value) {
          skuParts.push(slugify(value));
          nameParts.push(value);
        }
      }

      variations.push({
        sku: skuParts.join('-'),
        name: nameParts.join(' - '),
        optionValues: { ...current },
      });
      return;
    }

    const option = options[index];
    for (const value of option.values) {
      cartesianProduct(options, index + 1, {
        ...current,
        [option.id]: value,
      });
    }
  }

  cartesianProduct(validOptions);
  return variations;
}

/**
 * Calculate total number of variations that will be generated
 */
export function calculateVariationCount(optionTypes: OptionType[]): number {
  const validOptions = optionTypes.filter(
    (opt) => opt.values && opt.values.length > 0
  );

  if (validOptions.length === 0) {
    return 0;
  }

  return validOptions.reduce((count, opt) => count * opt.values.length, 1);
}

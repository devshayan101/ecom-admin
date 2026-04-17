import * as fs from "fs";
import * as path from "path";

// Workaround for broken type definitions in Medusa v2
const CoreFlows = require("@medusajs/medusa/core-flows");
const WorkflowsSDK = require("@medusajs/workflows-sdk");

const {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
  updateProductsWorkflow,
} = CoreFlows;

const {
  createWorkflow,
  transform,
  WorkflowResponse,
} = WorkflowsSDK;

const BASE_URL = "http://localhost:8000";
const DEFAULT_STOCK = 100;

// Re-defining ProductStatus since imports are messy in this version
const ProductStatus = {
  PUBLISHED: "published",
  DRAFT: "draft",
  PROPOSED: "proposed",
  REJECTED: "rejected",
};

function parseCSV(content: string): any[] {
  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++; 
      } else if (char === '"') {
        if (nextChar === '"') {
           currentField += '"';
           i++;
        } else {
           inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && nextChar === "\n") i++;
        currentRow.push(currentField.trim());
        if (currentRow.length > 1 || currentRow[0] !== "") {
          lines.push(currentRow);
        }
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    lines.push(currentRow);
  }

  const headers = lines[0];
  return lines.slice(1).map((row) => {
    const obj: any = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

function normalizeImageUrl(url: string | undefined, handle?: string): string | undefined {
  if (!url) return undefined;
  
  if (handle && (handle === "opaline-essence" || handle === "moonbeam-night-cream" || handle === "halo-face-primer" || handle === "nova-nail-lacquer" || handle === "radiance-body-oil")) {
      return `${BASE_URL}/products/${handle}.png`;
  }

  let cleanUrl = url.replace(/_\d+(\.[a-zA-Z]+)$/, "$1");
  if (cleanUrl.startsWith("http")) return cleanUrl;
  if (cleanUrl.startsWith("/")) return `${BASE_URL}${cleanUrl}`;
  return `${BASE_URL}/${cleanUrl}`;
}

export default async function importProducts({ container }: any) {
  const logger = container.resolve("logger") as any;
  const query = container.resolve("query") as any;
  const salesChannelModuleService = container.resolve("salesChannelService");
  const fulfillmentModuleService = container.resolve("fulfillmentService");
  const productModuleService = container.resolve("productService");
  const inventoryModuleService = container.resolve("inventoryService");

  const csvPath = path.resolve(process.cwd(), "..", "products-liquid-glass.csv");
  if (!fs.existsSync(csvPath)) {
    logger.error(`CSV file not found at ${csvPath}`);
    return;
  }

  logger.info(`Reading CSV from ${csvPath}...`);
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const data = parseCSV(csvContent);

  // 1. Fetch Defaults
  const [defaultSalesChannel] = await salesChannelModuleService.listSalesChannels({
    name: "Default Sales Channel",
  });
  const shippingProfiles = await fulfillmentModuleService.listShippingProfiles({
    type: "default",
  });
  const shippingProfile = shippingProfiles[0];

  const { data: locations } = await query.graph({
    entity: "stock_location",
    fields: ["id"],
  });
  const stockLocation = locations[0];

  if (!defaultSalesChannel || !shippingProfile || !stockLocation) {
    logger.error("Default SC, Shipping Profile, or Stock Location not found.");
    return;
  }

  // 2. Process Categories
  logger.info("Processing categories...");
  const categoryPaths = new Set<string>();
  data.forEach((row) => {
    const c1 = row["Product Category 1"];
    const c2 = row["Product Category 2"];
    const c3 = row["Product Category 3"];
    if (c1) {
      categoryPaths.add(c1);
      if (c2) {
        categoryPaths.add(`${c1} > ${c2}`);
        if (c3) {
          categoryPaths.add(`${c1} > ${c2} > ${c3}`);
        }
      }
    }
  });

  const categoriesMap = new Map<string, any>();
  const categoryTree = Array.from(categoryPaths).sort((a, b) => a.split(" > ").length - b.split(" > ").length);

  for (const p of categoryTree) {
    const parts = p.split(" > ");
    const name = parts[parts.length - 1];
    const handle = p.toLowerCase().replace(/ > /g, "-").replace(/ /g, "-").replace(/'/g, "");
    const [existing] = await productModuleService.listProductCategories({ handle });
    if (existing) {
      categoriesMap.set(p, existing);
      continue;
    }
    try {
      const { result } = await (createProductCategoriesWorkflow(container) as any).run({
        input: {
          product_categories: [{ name, handle, is_active: true }],
        },
      });
      categoriesMap.set(p, result[0]);
    } catch (err) {}
  }

  // 3. Map Products
  logger.info("Mapping products from CSV...");
  const productsMap = new Map<string, any>();
  const usedSkus = new Set<string>();

  data.forEach((row) => {
    const handle = row["Product Handle"] || row["Product Title"]?.toLowerCase().replace(/ /g, "-");
    if (!handle) return;

    if (!productsMap.has(handle)) {
      const catPath = [row["Product Category 1"], row["Product Category 2"], row["Product Category 3"]].filter(Boolean).join(" > ");
      const category = categoriesMap.get(catPath);

      const thumbnail = normalizeImageUrl(row["Product Thumbnail"], handle);
      const image1 = normalizeImageUrl(row["Product Image 1 Url"]);
      let image2 = normalizeImageUrl(row["Product Image 2 Url"]);

      if (!image2 && (row["Product Category 1"] === "Apparel" || row["Product Category 1"] === "Fragrance")) {
         image2 = `${BASE_URL}/products/${handle}-alt.png`;
      }

      const galleryImages = Array.from(new Set([thumbnail, image1, image2]))
        .filter(Boolean)
        .map(url => ({ url }));

      productsMap.set(handle, {
        title: row["Product Title"] || "Untitled Product",
        subtitle: row["Product Subtitle"] || "",
        description: row["Product Description"] || "",
        handle: handle,
        status: ProductStatus.PUBLISHED,
        thumbnail: thumbnail,
        weight: parseFloat(row["Product Weight"]) || 0,
        shipping_profile_id: shippingProfile.id,
        sales_channels: [{ id: defaultSalesChannel.id }],
        category_ids: category ? [category.id] : [],
        images: galleryImages,
        options: [{ title: row["Variant Option 1 Name"] || "Size", values: [] }],
        variants: [],
      });
    }

    const product = productsMap.get(handle);
    const optionName = row["Variant Option 1 Name"] || "Size";
    const optionValue = row["Variant Option 1 Value"] || "Default";
    
    if (!product.options[0].values.includes(optionValue)) {
      product.options[0].values.push(optionValue);
    }

    const prices: any[] = [];
    if (row["Variant Price EUR"]) prices.push({ currency_code: "eur", amount: parseFloat(row["Variant Price EUR"]) });
    if (row["Variant Price USD"]) prices.push({ currency_code: "usd", amount: parseFloat(row["Variant Price USD"]) });
    if (prices.length === 0) prices.push({ currency_code: "usd", amount: 1000 });

    let sku = row["Variant SKU"];
    if (!sku || sku === "Standard" || sku === "Default") {
      sku = `SKU-${handle}-${optionValue}`.toUpperCase();
    }
    let finalSku = sku;
    let counter = 1;
    while (usedSkus.has(finalSku)) {
      finalSku = `${sku}-${counter++}`;
    }
    usedSkus.add(finalSku);

    product.variants.push({
      title: row["Variant Title"] || optionValue,
      sku: finalSku,
      options: { [optionName]: optionValue },
      prices,
      manage_inventory: true,
    });
  });

  // 4. Update Database
  const allHandles = Array.from(productsMap.keys());
  const { data: existingProducts } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "variants.*"],
    filters: { handle: allHandles }
  });
  const existingHandlesMap = new Map(existingProducts.map(p => [p.handle, p]));

  const productsToCreate = Array.from(productsMap.values()).filter(p => !existingHandlesMap.has(p.handle));
  const productsToUpdate = Array.from(productsMap.values())
    .filter(p => existingHandlesMap.has(p.handle))
    .map(p => {
       const existing = existingHandlesMap.get(p.handle) as any;
       const variants = p.variants.map((v: any) => {
          const existingVariant = existing.variants.find((ev: any) => ev.sku === v.sku);
          return {
             id: existingVariant?.id,
             ...v
           };
       });

       return {
         id: existing!.id,
         thumbnail: p.thumbnail,
         images: p.images,
         variants: variants
       };
    });

  if (productsToCreate.length > 0) {
    logger.info(`Creating ${productsToCreate.length} products...`);
    await (createProductsWorkflow(container) as any).run({ input: { products: productsToCreate } });
  }

  if (productsToUpdate.length > 0) {
    logger.info(`Updating prices/images/thumbnails for ${productsToUpdate.length} products...`);
    await (updateProductsWorkflow(container) as any).run({ input: { products: productsToUpdate } });
  }

  // 5. Inventory (Stock FORCE UPDATE)
  logger.info("Force-updating stock levels to 100...");
  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
  });

  const { data: existingLevels } = await query.graph({
    entity: "inventory_level",
    fields: ["id", "inventory_item_id"],
    filters: { location_id: stockLocation.id }
  });
  
  const existingLevelsMap = new Map(existingLevels.map(l => [l.inventory_item_id, l.id]));

  const levelsToCreate: any[] = [];
  
  for (const item of inventoryItems) {
    const existingLevelId = existingLevelsMap.get(item.id);
    if (!existingLevelId) {
      levelsToCreate.push({
        location_id: stockLocation.id,
        stocked_quantity: DEFAULT_STOCK,
        inventory_item_id: item.id,
      });
    } else {
       try {
           await inventoryModuleService.updateInventoryLevels({
              inventory_item_id: item.id,
              location_id: stockLocation.id,
              stocked_quantity: DEFAULT_STOCK
           });
       } catch (err) {
           logger.warn(`Failed to update level for ${item.id}: ${err.message}`);
       }
    }
  }

  if (levelsToCreate.length > 0) {
    await createInventoryLevelsWorkflow(container).run({
      input: { inventory_levels: levelsToCreate },
    });
    logger.info(`Created ${levelsToCreate.length} new inventory levels.`);
  }

  logger.info("Catalog fix finished.");
}

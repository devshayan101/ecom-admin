import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse/sync";

// Workaround for broken type definitions in Medusa v2
const WorkflowsSDK = require("@medusajs/workflows-sdk");
const { createWorkflow, WorkflowResponse } = WorkflowsSDK;

export default async function updatePricesInr({ container }: any) {
  const logger = container.resolve("logger") as any;
  const query = container.resolve("query") as any;
  const pricingService = container.resolve("pricing") as any;
  const storeService = container.resolve("store") as any;

  logger.info("Starting INR price update script...");

  // 1. Ensure INR is in store currencies
  const { data: [store] } = await query.graph({
    entity: "store",
    fields: ["id", "supported_currencies.*"]
  }) as any;

  if (store && !store.supported_currencies?.find((c: any) => c.currency_code === "inr")) {
    logger.info("Adding INR to store currencies...");
    try {
      await storeService.updateStores(store.id, {
        supported_currencies: [
          ...(store.supported_currencies || []),
          { currency_code: "inr", is_default: false }
        ]
      });
    } catch (err) {
      logger.warn(`Could not add INR to store. It might already exist or the format is wrong: ${err.message}`);
    }
  }

  // 2. Read and parse CSV
  const csvPath = path.resolve(process.cwd(), "..", "products-liquid-glass.csv");
  if (!fs.existsSync(csvPath)) {
    logger.error(`CSV file not found at ${csvPath}`);
    return;
  }

  const fileContent = fs.readFileSync(csvPath, "utf-8");
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
  });

  const productDataMap = new Map();
  for (const record of records) {
    if (record["Product Handle"]) {
      productDataMap.set(record["Product Handle"], record);
    }
  }

  // 3. Get all variants with their price sets
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "product.handle", "price_set.id", "price_set.prices.*"],
  });

  logger.info(`Found ${variants.length} variants to process.`);

  let updatedCount = 0;
  for (const variant of variants) {
    const handle = variant.product?.handle;
    const csvData = productDataMap.get(handle);

    if (!csvData) {
      continue;
    }

    // Determine base price in USD or EUR
    let usdPriceStr = csvData["Variant Price USD"];
    let eurPriceStr = csvData["Variant Price EUR"];
    
    let usdPrice = parseFloat(usdPriceStr || "0");
    if (isNaN(usdPrice) || usdPrice === 0) {
      const eurPrice = parseFloat(eurPriceStr || "0");
      if (isNaN(eurPrice) || eurPrice === 0) {
        logger.warn(`No price found in CSV for variant ${variant.sku} (handle: ${handle}). Skipping.`);
        continue;
      }
      usdPrice = eurPrice * 1.1; // fallback conversion if USD is missing
    }

    logger.info(`Processing variant ${variant.sku} (handle: ${handle})...`);
    if (!variant.price_set?.id) {
       logger.warn(`Variant ${variant.sku} (id: ${variant.id}) has no price set. Skipping.`);
       continue;
    }

    // Convert to INR (USD * 80)
    const inrAmount = Math.round(usdPrice * 80);

    // Check if INR price already exists
    const existingInrPrice = variant.price_set.prices?.find((p: any) => p.currency_code === "inr");

    try {
      if (existingInrPrice) {
        // Update existing price inside the price set
        await pricingService.updatePriceSets(variant.price_set.id, {
          prices: [
            {
              id: existingInrPrice.id,
              amount: inrAmount,
            }
          ]
        });
      } else {
        // Add new price to the price set
        await pricingService.addPrices({
          priceSetId: variant.price_set.id,
          prices: [
            {
              amount: inrAmount,
              currency_code: "inr",
            }
          ]
        });
      }
      updatedCount++;
    } catch (err) {
      logger.error(`Failed to update price for variant ${variant.sku}: ${err.message}`);
    }

    if (updatedCount % 10 === 0 && updatedCount > 0) {
      logger.info(`Updated prices for ${updatedCount} variants...`);
    }
  }

  logger.info(`Finished! Updated ${updatedCount} variants to INR prices.`);
}

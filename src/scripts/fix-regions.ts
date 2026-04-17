
const CoreFlows = require("@medusajs/medusa/core-flows");
const WorkflowsSDK = require("@medusajs/workflows-sdk");

const {
  createRegionsWorkflow,
  createTaxRegionsWorkflow,
  updateStoresWorkflow,
} = CoreFlows;

const {
  createWorkflow,
  transform,
  WorkflowResponse,
} = WorkflowsSDK;

const updateStoreCurrencies = createWorkflow(
  "update-store-currencies",
  (input: {
    supported_currencies: { currency_code: string; is_default?: boolean }[];
    store_id: string;
  }) => {
    const normalizedInput = transform({ input }, (data) => {
      return {
        selector: { id: data.input.store_id },
        update: {
          supported_currencies: data.input.supported_currencies.map(
            (currency) => {
              return {
                currency_code: currency.currency_code,
                is_default: currency.is_default ?? false,
              };
            }
          ),
        },
      };
    });

    const stores = updateStoresWorkflow(normalizedInput);

    return new WorkflowResponse(stores);
  }
);

const { Modules } = require("@medusajs/utils");

export default async function fixRegions({ container }: any) {
  const logger = container.resolve("logger") as any;
  const query = container.resolve("query") as any;
  const storeModuleService = container.resolve(Modules.STORE) as any;
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL) as any;

  logger.info("Starting fix-regions script...");

  // 1. Get Store and Default Sales Channel
  const [store] = await storeModuleService.listStores();
  const [defaultSalesChannel] = await salesChannelModuleService.listSalesChannels({
    name: "Default Sales Channel",
  });

  if (!store || !defaultSalesChannel) {
    logger.error("Store or Default Sales Channel not found.");
    return;
  }

  // 2. Update Store Currencies to include USD and INR
  logger.info("Updating store currencies...");
  await updateStoreCurrencies(container).run({
    input: {
      store_id: store.id,
      supported_currencies: [
        { currency_code: "eur", is_default: true },
        { currency_code: "usd" },
        { currency_code: "inr" },
      ],
    },
  });

  // 3. Check existing regions
  const { data: existingRegions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "currency_code"],
  });

  const regionsToCreate: any[] = [];

  if (!existingRegions.find((r: any) => r.name === "United States" || r.currency_code === "usd")) {
    regionsToCreate.push({
      name: "United States",
      currency_code: "usd",
      countries: ["us"],
      payment_providers: ["pp_system_default"],
    });
  }

  if (!existingRegions.find((r: any) => r.name === "India" || r.currency_code === "inr")) {
    regionsToCreate.push({
      name: "India",
      currency_code: "inr",
      countries: ["in"],
      payment_providers: ["pp_system_default"],
    });
  }

  if (regionsToCreate.length > 0) {
    logger.info(`Creating ${regionsToCreate.length} regions...`);
    const { result: regionResult } = await createRegionsWorkflow(container).run({
      input: {
        regions: regionsToCreate,
      },
    });

    // 4. Create Tax Regions for new countries
    const countries = regionsToCreate.flatMap(r => r.countries);
    logger.info(`Creating tax regions for: ${countries.join(", ")}`);
    await createTaxRegionsWorkflow(container).run({
      input: countries.map((country_code) => ({
        country_code,
        provider_id: "tp_system",
      })),
    });
  } else {
    logger.info("Regions already exist.");
  }

  logger.info("fix-regions script finished successfully.");
}

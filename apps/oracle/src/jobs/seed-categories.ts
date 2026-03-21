/**
 * Seed coin categories into the database
 * Run this once to initialize the category lookup table
 */

import { getCategories, upsertCoinCategory } from "../store.js";

const categories = [
  {
    id: "eligible",
    name: "Eligible",
    description: "Regular cryptocurrencies eligible for DEF/MID/FWD positions",
    sort_order: 1,
  },
  {
    id: "stablecoin",
    name: "Stablecoin",
    description: "Stablecoins used for GK (goalkeeper) position",
    sort_order: 2,
  },
  {
    id: "excluded",
    name: "Excluded",
    description: "Excluded coins (wrapped, bridged, staking derivatives, etc.)",
    sort_order: 3,
  },
];

const seed = async () => {
  for (const category of categories) {
    await upsertCoinCategory(category);
  }

  await getCategories();
};

seed().catch(() => {
  process.exit(1);
});

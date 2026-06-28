import { loadRestaurantFromEnv } from "./env-loader.js";
import type { RestaurantConfig } from "./types.js";

export const DEMO_RESTAURANT: RestaurantConfig = loadRestaurantFromEnv();

export const restaurantRegistry: Record<string, RestaurantConfig> = {
  [DEMO_RESTAURANT.id]: DEMO_RESTAURANT,
};

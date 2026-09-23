/**
 * Fleet layer public API.
 */

import type { ToolContext } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { loadFleetConfig } from "./config.js";
import { FleetController } from "./controller.js";
import type { FleetConfig } from "./types.js";

export * from "./types.js";
export { loadFleetConfig, DEFAULT_FLEET_CONFIG, FLEET_HARD_MAX_AGENTS } from "./config.js";
export { FleetRegistry, FleetBypassError } from "./registry.js";
export { FleetController } from "./controller.js";
export {
  computeFleetState,
  evaluateReplication,
  evaluateToolCall,
  evaluateFinancialEligibility,
  EMERGENCY_BLOCKED_TOOLS,
} from "./policy.js";

/** Build a controller bound to the running automaton's tool context. */
export function createFleetControllerForContext(
  ctx: Pick<ToolContext, "db" | "identity" | "config" | "conway">,
  fleetConfig: FleetConfig = loadFleetConfig(),
): FleetController {
  return new FleetController({
    db: ctx.db.raw,
    config: fleetConfig,
    self: { address: ctx.identity.address, name: ctx.config.name },
    isRootAgent: !ctx.config.parentAddress,
    getFinancialSnapshot: async () => {
      const creditsCents = await ctx.conway.getCreditsBalance();
      return { creditsCents, survivalTier: getSurvivalTier(creditsCents) };
    },
  });
}

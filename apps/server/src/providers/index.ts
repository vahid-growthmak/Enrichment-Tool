import type { Config } from "../config.js";
import { ApolloProvider } from "./apollo.js";
import { FullEnrichProvider } from "./fullenrich.js";
import type { EnrichmentProvider } from "./types.js";

/** Waterfall order is fixed: Apollo first, FullEnrich as fallback. */
export function createProviders(cfg: Config): EnrichmentProvider[] {
  return [new ApolloProvider(cfg), new FullEnrichProvider(cfg)];
}

export type { EnrichmentProvider } from "./types.js";

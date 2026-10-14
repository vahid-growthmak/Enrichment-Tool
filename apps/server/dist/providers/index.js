import { ApolloProvider } from "./apollo.js";
import { FullEnrichProvider } from "./fullenrich.js";
/** Waterfall order is fixed: Apollo first, FullEnrich as fallback. */
export function createProviders(cfg) {
    return [new ApolloProvider(cfg), new FullEnrichProvider(cfg)];
}
//# sourceMappingURL=index.js.map
import type { PluginCardKind } from "@t3tools/contracts";
import type { ComponentType } from "react";

import { cardRenderers } from "./cards";
import type { PluginCardRendererMap, PluginCardRendererProps } from "./core/types";
import { DecisionCard } from "./decision/DecisionCard";
import { liveCardRenderers } from "./live";

const builtInRenderers: PluginCardRendererMap = { "dispatch.decision": DecisionCard };

export function pluginCardRenderer(
  kind: PluginCardKind,
): ComponentType<PluginCardRendererProps<PluginCardKind>> | null {
  const renderer = builtInRenderers[kind] ?? cardRenderers[kind] ?? liveCardRenderers[kind];
  // Each map is keyed by kind, so the caller's card always has the kind this renderer takes.
  return (renderer as ComponentType<PluginCardRendererProps<PluginCardKind>> | undefined) ?? null;
}

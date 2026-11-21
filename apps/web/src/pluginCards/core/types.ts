import type {
  EnvironmentId,
  PluginCard,
  PluginCardKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { ComponentType } from "react";

export type PluginCardRendererProps<K extends PluginCardKind> = {
  readonly card: Extract<PluginCard, { kind: K }>;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
};

export type PluginCardRendererMap = {
  readonly [K in PluginCardKind]?: ComponentType<PluginCardRendererProps<K>>;
};

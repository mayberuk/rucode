import type { PluginCardRendererMap } from "../core/types";
import { DispatchPlanCard } from "./DispatchPlanCard";
import { DispatchRunProgressCard } from "./DispatchRunProgressCard";
import { DispatchVerifyCard } from "./DispatchVerifyCard";
import { GittyConflictCard } from "./GittyConflictCard";
import { GittyPushCard } from "./GittyPushCard";
import { Iter8RoundCard } from "./Iter8RoundCard";
import { LivecheckProgressCard } from "./LivecheckProgressCard";
import { LivecheckResultCard } from "./LivecheckResultCard";

export const cardRenderers: PluginCardRendererMap = {
  "dispatch.plan": DispatchPlanCard,
  "dispatch.verify": DispatchVerifyCard,
  "dispatch.runProgress": DispatchRunProgressCard,
  "livecheck.result": LivecheckResultCard,
  "livecheck.progress": LivecheckProgressCard,
  "iter8.round": Iter8RoundCard,
  "gitty.push": GittyPushCard,
  "gitty.conflict": GittyConflictCard,
};

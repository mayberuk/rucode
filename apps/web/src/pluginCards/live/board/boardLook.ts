import type {
  PluginCheckState,
  PluginInitiativePartStatus,
  PluginStepState,
} from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react";

export interface BoardLook {
  readonly icon: LucideIcon;
  readonly className: string;
}

export const PART_STATUS_LOOK: Readonly<Record<PluginInitiativePartStatus, BoardLook>> = {
  planned: { icon: CircleIcon, className: "text-muted-foreground/70" },
  briefed: { icon: CircleIcon, className: "text-muted-foreground" },
  specced: { icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  queued: { icon: ClockIcon, className: "text-muted-foreground" },
  running: { icon: CircleDashedIcon, className: "text-info-foreground" },
  gating: { icon: CircleDashedIcon, className: "text-info-foreground" },
  "gate-fail": { icon: CircleAlertIcon, className: "text-destructive-foreground" },
  "gate-pass": { icon: CircleCheckIcon, className: "text-info-foreground" },
  "mr-open": { icon: GitPullRequestIcon, className: "text-info-foreground" },
  merged: { icon: CircleCheckIcon, className: "text-success-foreground" },
};

export const PHASE_STATE_LOOK: Readonly<Record<PluginStepState, BoardLook>> = {
  done: { icon: CircleCheckIcon, className: "text-success-foreground" },
  running: { icon: CircleDashedIcon, className: "text-info-foreground" },
  failed: { icon: CircleAlertIcon, className: "text-destructive-foreground" },
  pending: { icon: CircleIcon, className: "text-muted-foreground/70" },
  stale: { icon: CircleDotDashedIcon, className: "text-muted-foreground/70" },
};

export const CHECK_STATE_LOOK: Readonly<Record<PluginCheckState, BoardLook>> = {
  pass: { icon: CircleCheckIcon, className: "text-success-foreground" },
  fail: { icon: CircleXIcon, className: "text-destructive-foreground" },
  running: { icon: CircleDashedIcon, className: "text-info-foreground" },
  pending: { icon: CircleIcon, className: "text-muted-foreground/70" },
  stale: { icon: CircleDotDashedIcon, className: "text-muted-foreground/70" },
  skipped: { icon: CircleSlashIcon, className: "text-muted-foreground/70" },
};

export const PHASE_SEGMENT_CLASS: Readonly<Record<PluginStepState, string>> = {
  pending: "bg-muted-foreground/22",
  stale: "bg-muted-foreground/22",
  done: "bg-foreground/60",
  running: "bg-info",
  failed: "bg-destructive-foreground",
};

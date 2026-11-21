import {
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  HistoryIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { toneClassName, type CardTone, type CheckIconName } from "../dispatchCards.logic";

const ICONS = {
  check: CheckIcon,
  x: XIcon,
  history: HistoryIcon,
  dashed: CircleDashedIcon,
  circle: CircleIcon,
  minus: MinusIcon,
} as const satisfies Record<CheckIconName, typeof CheckIcon>;

export function CardStatusLabel({
  icon,
  tone,
  label,
}: {
  icon: CheckIconName;
  tone: CardTone;
  label: string;
}) {
  const Icon = ICONS[icon];
  return (
    <span className={cn("inline-flex items-center gap-1.5", toneClassName(tone))}>
      <Icon aria-hidden className="size-4 shrink-0 stroke-2" />
      {label}
    </span>
  );
}

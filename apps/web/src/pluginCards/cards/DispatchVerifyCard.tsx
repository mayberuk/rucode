import {
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  HistoryIcon,
  MinusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { checkTone, toneClassName, type CheckIconName } from "./dispatchCards.logic";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { shortSha } from "./shared/cardFormat.logic";

const ICONS = {
  check: CheckIcon,
  x: XIcon,
  history: HistoryIcon,
  dashed: CircleDashedIcon,
  circle: CircleIcon,
  minus: MinusIcon,
} as const satisfies Record<CheckIconName, typeof CheckIcon>;

export function DispatchVerifyCard({
  card,
  threadRef,
}: PluginCardRendererProps<"dispatch.verify">) {
  const data = card.data;
  const revision = shortSha(data.revision);
  return (
    <PluginCardShell
      label="Verify"
      title={
        <>
          <span>Verify</span>
          <span className="min-w-0 truncate font-normal">{data.task}</span>
          {revision === null ? null : (
            <span className="font-normal text-muted-foreground">
              at <span className="font-mono">{revision}</span>
            </span>
          )}
        </>
      }
      actions={
        <PluginCardActionButton
          card={card}
          actionId="rerun"
          threadRef={threadRef}
          icon={<RotateCcwIcon className="size-3" />}
        />
      }
    >
      {data.checks.length === 0 ? (
        <p className="px-3 pb-2.5 text-sm text-muted-foreground">No checks yet</p>
      ) : (
        <div className="chat-markdown px-3 pb-2">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.checks.map((check) => {
                const { icon, tone, label } = checkTone(check.state);
                const Icon = ICONS[icon];
                return (
                  <tr key={check.name}>
                    <td>{check.name}</td>
                    <td>{check.summary}</td>
                    <td>
                      <span className={cn("inline-flex items-center gap-1.5", toneClassName(tone))}>
                        <Icon aria-hidden className="size-4 shrink-0 stroke-2" />
                        {label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PluginCardShell>
  );
}

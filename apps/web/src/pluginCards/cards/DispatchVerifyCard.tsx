import { RotateCcwIcon } from "lucide-react";

import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { checkTone } from "./dispatchCards.logic";
import { CardStatusLabel } from "./shared/CardStatusLabel";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { shortSha } from "./shared/cardFormat.logic";

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
        <span className="inline-flex min-w-0 items-center gap-x-3">
          <span className="shrink-0">Verify</span>
          <span className="min-w-0 truncate font-mono font-normal">{data.task}</span>
          {revision === null ? null : (
            <span className="shrink-0 font-normal text-muted-foreground">
              at <span className="font-mono">{revision}</span>
            </span>
          )}
        </span>
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
                return (
                  <tr key={check.name}>
                    <td>{check.name}</td>
                    <td>{check.summary}</td>
                    <td>
                      <CardStatusLabel {...checkTone(check.state)} />
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

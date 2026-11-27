import type { PluginInitiativeWave } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";

import { PartRow } from "./PartRow";

export function WaveGroup({
  wave,
  total,
  previousName,
  now,
  onOpenPart,
}: {
  readonly wave: PluginInitiativeWave;
  readonly total: number;
  readonly previousName: string | null;
  readonly now: string;
  readonly onOpenPart: (partId: string) => void;
}) {
  const gt = useGT();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? wave.state === "active";
  const title =
    wave.moreParts > 0
      ? gt("{name} and {count, plural, one {# more part} other {# more parts}}", {
          name: wave.name,
          count: wave.moreParts,
        })
      : wave.name;
  const state =
    wave.state === "done"
      ? gt("done")
      : wave.state === "active"
        ? gt("in progress")
        : previousName === null
          ? gt("waiting")
          : gt("waits on {name}", { name: previousName });

  return (
    <Collapsible open={open} onOpenChange={setUserOpen}>
      <CollapsibleTrigger
        render={
          <CollapsibleSectionHeader
            expanded={open}
            tone="emphasized"
            variant="panel"
            accessory={
              <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
                {gt("{settled} of {total} settled", {
                  settled: wave.partsSettled,
                  total: wave.partsTotal,
                })}
              </span>
            }
          />
        }
      >
        {title}{" "}
        <span className="ms-1 font-normal text-muted-foreground">
          {gt("Wave {number} of {total} · {state}", { number: wave.number, total, state })}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col pt-1">
          {wave.parts.map((part) => (
            <PartRow key={part.id} part={part} now={now} onOpen={onOpenPart} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

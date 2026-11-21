import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { InitiativeSection } from "./BoardPage";
import { boardInitiatives } from "./liveStateIndex";

import "~/index.css";

const environmentId = EnvironmentId.make("env-a");

const section = (running: number) => {
  const [item] = boardInitiatives([
    {
      environmentId,
      state: {
        asOf: "2026-11-21T09:00:00Z",
        children: [],
        decisions: [],
        waitingThreadIds: [],
        initiatives: [
          {
            slug: "alpha",
            title: "Alpha",
            closed: false,
            wave: { current: 1, total: 1, partsSettled: 0, partsTotal: 0 },
            settled: { count: 0, total: 0 },
            running,
            openDecisions: 0,
            spend: { usd: null, state: "unknown" },
            orchestratorThreadId: null,
            asOf: "2026-11-21T09:00:00Z",
            parts: [],
          },
        ],
      },
    },
  ]);
  return <InitiativeSection item={item!} environmentLabel={null} now="2026-11-21T09:05:00Z" />;
};

it("follows the initiative's activity until the user toggles the section", async () => {
  await using screen = await render(section(0));
  const header = screen.getByRole("button", { name: /Alpha/ });
  await expect.element(header).toHaveAttribute("aria-expanded", "false");

  await screen.rerender(section(1));
  await expect.element(header).toHaveAttribute("aria-expanded", "true");

  await screen.rerender(section(0));
  await expect.element(header).toHaveAttribute("aria-expanded", "false");

  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
  await screen.rerender(section(1));
  await screen.rerender(section(0));
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
});

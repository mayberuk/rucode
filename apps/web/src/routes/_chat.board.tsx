import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../pluginCards/live/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  component: BoardPage,
});

import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../pluginCards/live/BoardPage";
import { boardSearchFromUrl } from "../pluginCards/live/boardSearch";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: boardSearchFromUrl,
  component: BoardPage,
});

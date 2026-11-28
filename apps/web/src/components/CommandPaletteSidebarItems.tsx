import { useGT } from "gt-react";
import { BellIcon, FolderIcon, ListIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

const SEARCH_TERMS = ["sidebar layout list projects folders needs you"] as const;

export function useCommandPaletteSidebarItems(): CommandPaletteActionItem[] {
  const gt = useGT();
  const sidebarLayout = useClientSettings((settings) => settings.sidebarLayout);
  const needsYouFirst = useClientSettings((settings) => settings.sidebarNeedsYouFirst);
  const layoutOptions = [
    { layout: "list", title: gt("Sidebar layout: List"), icon: ListIcon },
    { layout: "projects", title: gt("Sidebar layout: Projects"), icon: FolderIcon },
  ] as const;

  return [
    ...layoutOptions.map(({ layout, title, icon: Icon }) => ({
      kind: "action" as const,
      value: `sidebar-layout:${layout}`,
      searchTerms: SEARCH_TERMS,
      title,
      icon: <Icon className={ITEM_ICON_CLASS} />,
      titleTrailingContent:
        sidebarLayout === layout ? (
          <span className="text-xs text-muted-foreground/70">{gt("Current")}</span>
        ) : undefined,
      run: () => updateClientSettings({ sidebarLayout: layout }),
    })),
    {
      kind: "action",
      value: "action:sidebar-needs-you-first",
      searchTerms: SEARCH_TERMS,
      title: needsYouFirst ? gt('Hide "Needs you" first') : gt('Show "Needs you" first'),
      icon: <BellIcon className={ITEM_ICON_CLASS} />,
      run: () => updateClientSettings({ sidebarNeedsYouFirst: !needsYouFirst }),
    },
  ];
}

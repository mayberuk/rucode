import type { ReactNode } from "react";

export function PluginCardShell({
  label,
  title,
  actions,
  children,
}: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} className="mt-4 rounded-lg bg-secondary dark:bg-input/20">
      <div className="flex items-center justify-between gap-2 rounded-t-lg px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          {title}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

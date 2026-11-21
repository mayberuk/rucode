import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { CheckboxMark } from "../ui/checkbox";
import { Kbd } from "../ui/kbd";

export function ComposerOptionRow({
  indicator,
  selected,
  disabled,
  label,
  description,
  shortcutDigit,
  className,
  onClick,
}: {
  indicator: "radio" | "checkbox";
  selected: boolean;
  disabled: boolean;
  label: string;
  description?: string | undefined;
  shortcutDigit: number | null;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        className,
        "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
        selected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
        disabled && "opacity-50 cursor-not-allowed",
        !disabled && "cursor-pointer",
      )}
    >
      {/* The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line. */}
      <span className="pointer-events-none flex h-5 shrink-0 items-center">
        {indicator === "checkbox" ? (
          <CheckboxMark checked={selected} variant="contrast" />
        ) : (
          <OptionRadio checked={selected} />
        )}
      </span>
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-sm font-medium" dir={textDirection(label)}>
          {label}
        </span>
        {description ? (
          <span className="text-secondary-label text-2xs" dir={textDirection(description)}>
            {description}
          </span>
        ) : null}
      </div>
      {shortcutDigit !== null ? (
        <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
          <Kbd>{shortcutDigit}</Kbd>
        </span>
      ) : null}
    </button>
  );
}

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-foreground/55 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}

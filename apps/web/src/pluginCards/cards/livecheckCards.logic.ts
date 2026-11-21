import type { LivecheckResultCardData } from "@t3tools/contracts";

type Verdict = LivecheckResultCardData["verdict"];

export interface VerdictPresentation {
  readonly label: string;
  readonly icon: "check" | "x" | "alert";
  readonly tone: "success" | "destructive" | "warning";
}

export function verdictPresentation(verdict: Verdict): VerdictPresentation {
  switch (verdict) {
    case "pass":
      return { label: "Passed", icon: "check", tone: "success" };
    case "fail":
      return { label: "Failed", icon: "x", tone: "destructive" };
    case "blocked":
      return { label: "Blocked", icon: "alert", tone: "warning" };
    case "error":
      return { label: "Error", icon: "alert", tone: "warning" };
  }
}

export function thumbnailCaption(step: { readonly index: number; readonly label: string }): string {
  return `${step.index}. ${step.label}`;
}

export interface ExpandableImage {
  readonly stepIndex: number;
  readonly src: string;
  readonly name: string;
}

export function expandableImages(
  steps: ReadonlyArray<{
    readonly index: number;
    readonly label: string;
    readonly assetId: string | null;
  }>,
  loadedUrls: ReadonlyMap<string, string>,
): ReadonlyArray<ExpandableImage> {
  return steps.flatMap((step) => {
    const src = step.assetId === null ? undefined : loadedUrls.get(step.assetId);
    return src === undefined ? [] : [{ stepIndex: step.index, src, name: thumbnailCaption(step) }];
  });
}

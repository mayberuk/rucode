import type { PluginCardId, ScopedThreadRef } from "@t3tools/contracts";
import { ImageOffIcon } from "lucide-react";
import { useEffect } from "react";

import { AttachmentImage } from "~/components/media/AttachmentImage";
import { cn } from "~/lib/utils";
import { usePluginCardAsset } from "../core/usePluginCards";

export function LivecheckThumbnail({
  threadRef,
  cardId,
  assetId,
  caption,
  failed,
  onExpand,
  onLoaded,
}: {
  threadRef: ScopedThreadRef;
  cardId: PluginCardId;
  assetId: string;
  caption: string;
  failed: boolean;
  /** Absent where the timeline cannot open an image viewer; the thumbnail is then not a button. */
  onExpand?: (() => void) | undefined;
  /** Reports the object URL while it is valid, and null once it is revoked. */
  onLoaded?: ((assetId: string, url: string | null) => void) | undefined;
}) {
  const asset = usePluginCardAsset(threadRef, cardId, assetId);
  const url = asset.status === "ready" ? asset.url : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes a browser object URL to the viewer's image list, withdrawn before the hook revokes it
  useEffect(() => {
    if (url === null || onLoaded === undefined) return;
    onLoaded(assetId, url);
    return () => onLoaded(assetId, null);
  }, [assetId, url, onLoaded]);

  const image =
    url === null ? null : (
      <AttachmentImage
        name={assetId}
        src={url}
        alt={caption}
        decoding="async"
        className="block size-full object-cover"
      />
    );

  return (
    <figure
      data-asset-state={asset.status}
      data-step-failed={failed ? "" : undefined}
      className="flex w-36 min-w-0 flex-col gap-1"
    >
      <div
        className={cn(
          "aspect-[4/3] overflow-hidden rounded-lg border",
          failed ? "border-destructive/64" : "border-border/80",
          asset.status === "loading" && "bg-muted",
        )}
      >
        {image !== null ? (
          onExpand ? (
            <button
              type="button"
              aria-label={`Preview ${caption}`}
              className="block size-full cursor-zoom-in"
              onClick={onExpand}
            >
              {image}
            </button>
          ) : (
            image
          )
        ) : asset.status === "failed" ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-2xs text-muted-foreground">
            <ImageOffIcon aria-hidden className="size-4 shrink-0" />
            <span className="line-clamp-3">{asset.message}</span>
          </div>
        ) : null}
      </div>
      <figcaption
        className={cn(
          "truncate text-2xs tabular-nums",
          failed ? "text-destructive-foreground" : "text-secondary-label",
        )}
      >
        {caption}
      </figcaption>
    </figure>
  );
}

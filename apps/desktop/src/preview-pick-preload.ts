import { ipcRenderer } from "electron";
import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";

import {
  ANNOTATION_THEME_CHANNEL,
  PASSKEY_BRIDGE_ARGUMENT,
  PRIMARY_PASTE_DISABLED_ARGUMENT,
  REVIEW_PINS_CHANNEL,
} from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";
import { createReviewPins, decodeReviewPinsInput } from "./preview/ReviewPins.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}

if (process.argv.includes(PRIMARY_PASTE_DISABLED_ARGUMENT)) {
  // Same guard as the app preload: Blink pastes PRIMARY on an uncancelled middle mouseup.
  window.addEventListener(
    "mouseup",
    (event) => {
      if (event.button === 1) event.preventDefault();
    },
    true,
  );
}

const reviewPins = createReviewPins(window);
ipcRenderer.on(
  REVIEW_PINS_CHANNEL,
  (_event, value: unknown, theme: DesktopPreviewAnnotationTheme | null | undefined) => {
    const input = decodeReviewPinsInput(value);
    if (input === undefined) return;
    if (theme) reviewPins.applyTheme(theme);
    reviewPins.update(input);
  },
);
ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, theme: DesktopPreviewAnnotationTheme | null) => {
  reviewPins.applyTheme(theme);
});

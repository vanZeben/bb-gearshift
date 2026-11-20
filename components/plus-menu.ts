import type { ComposerPlusMenuItem } from "@get-bb/plugin-sdk/app";
import { GEARSHIFT_ICON, POPUP_ID } from "./ids";

/** Plus-menu row: covers compact layouts, where composer actions are unavailable. */
export const toggleRow: ComposerPlusMenuItem = {
  id: "toggle",
  label: "Gearshift",
  icon: GEARSHIFT_ICON,
  description: "Turn automatic model and effort selection on or off, and see where this message would run",
  run({ composer }) {
    composer.experimental_openPopup(POPUP_ID);
  },
};

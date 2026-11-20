// Gearshift frontend: a composer pill + popup, and an analytics page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AnalyticsPage } from "@/components/analytics/page";
import { GEARSHIFT_ICON, PLUGIN_PANEL_PATH, POPUP_ID } from "@/components/ids";
import { GearshiftPill } from "@/components/pill";
import { NewThreadBanner } from "@/components/new-thread-banner";
import { toggleRow } from "@/components/plus-menu";
import { GearshiftPopup } from "@/components/popup";
import { PolicyEditor } from "@/components/settings/policy-editor";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "gearshift",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "pill", component: GearshiftPill }],
    banners: [{ id: "new-thread-state", chrome: "bare", component: NewThreadBanner }],
    plusMenu: [toggleRow],
    experimental_popups: [{ id: POPUP_ID, label: "Gearshift", component: GearshiftPopup }],
  });
  app.slots.settingsSection({
    id: "policy",
    title: "Routing policy",
    description:
      "What each message size runs on and how messages are scored. Your changes sit on top of Gearshift's defaults.",
    component: PolicyEditor,
  });
  app.slots.navPanel({
    id: "analytics",
    title: "Gearshift",
    icon: GEARSHIFT_ICON,
    path: PLUGIN_PANEL_PATH,
    component: AnalyticsPage,
  });
});

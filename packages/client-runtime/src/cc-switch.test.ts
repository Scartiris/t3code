import { describe, expect, it } from "vite-plus/test";
import { CC_SWITCH_ENGINES, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { addCcSwitchSite, removeCcSwitchSite, toggleCcSwitchSite } from "./cc-switch";

const site = { id: "second", name: "Second", baseUrl: "https://second.test", models: ["gpt-test"] };
const codex = CC_SWITCH_ENGINES[1];

describe("CC Switch site selection", () => {
  it("selects a first configured site for new engines while keeping existing routes", () => {
    const initial = { ...DEFAULT_SERVER_SETTINGS.ccSwitch, codexModel: "gpt-original" };
    const first = addCcSwitchSite(initial, site, []);
    expect(first.codexSiteIds).toEqual(["second"]);
    expect(first.codexSiteId).toBe("second");
    expect(first.codexModel).toBe("");
    const next = addCcSwitchSite(first, { ...site, id: "third" }, ["second"]);
    expect(next.codexSiteIds).toEqual(["second"]);
    expect(next.sites).toHaveLength(3);
  });
  it("adds another usable site without changing the default, and picks a new default when the old one is unchecked", () => {
    const initial = { ...DEFAULT_SERVER_SETTINGS.ccSwitch, codexModel: "gpt-original" };
    const multiple = toggleCcSwitchSite(initial, codex, "second", true);
    expect(multiple.codexSiteIds).toEqual(["default", "second"]);
    expect(multiple.codexModel).toBe("gpt-original");
    const moved = toggleCcSwitchSite(multiple, codex, "default", false);
    expect(moved.codexSiteIds).toEqual(["second"]);
    expect(moved.codexSiteId).toBe("second");
    expect(moved.codexModel).toBe("");
    expect(toggleCcSwitchSite(moved, codex, "second", false).codexSiteIds).toEqual([]);
  });
  it("removes a site's engine selections and keeps other selected sites enabled", () => {
    const multiple = toggleCcSwitchSite(
      { ...DEFAULT_SERVER_SETTINGS.ccSwitch, enabled: true },
      codex,
      "second",
      true,
    );
    const remaining = removeCcSwitchSite(
      { ...multiple, sites: [{ ...site, id: "default" }, site] },
      "default",
    );
    expect(remaining.codexSiteIds).toEqual(["second"]);
    expect(remaining.claudeSiteIds).toEqual([]);
    expect(remaining.openCodeSiteIds).toEqual([]);
    expect(remaining.enabled).toBe(true);
    expect(removeCcSwitchSite(remaining, "second").enabled).toBe(false);
  });
  it("keeps an explicitly disabled engine off when another site is added", () => {
    const next = addCcSwitchSite(
      { ...DEFAULT_SERVER_SETTINGS.ccSwitch, codexSiteIds: [] },
      site,
      [],
    );
    expect(next.codexSiteIds).toEqual([]);
    expect(next.claudeSiteIds).toEqual(["second"]);
  });
});

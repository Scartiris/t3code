import {
  CC_SWITCH_ENGINES,
  ccSwitchEngineSiteIds,
  ccSwitchSites,
  type CcSwitchEngine,
  type CcSwitchSettings,
  type CcSwitchSite,
} from "@t3tools/contracts";

export function toggleCcSwitchSite(
  settings: CcSwitchSettings,
  engine: CcSwitchEngine,
  siteId: string,
  checked: boolean,
): CcSwitchSettings {
  const selected = ccSwitchEngineSiteIds(settings, engine);
  const siteIds = checked
    ? [...new Set([...selected, siteId])]
    : selected.filter((id) => id !== siteId);
  const primary = siteIds.includes(settings[engine.siteField])
    ? settings[engine.siteField]
    : (siteIds[0] ?? "default");
  return {
    ...settings,
    [engine.sitesField]: siteIds,
    [engine.siteField]: primary,
    ...(primary !== settings[engine.siteField] ? { [engine.modelField]: "" } : {}),
  };
}

export function removeCcSwitchSite(settings: CcSwitchSettings, siteId: string): CcSwitchSettings {
  const sites = ccSwitchSites(settings).filter((site) => site.id !== siteId);
  const next = CC_SWITCH_ENGINES.reduce<CcSwitchSettings>(
    (current, engine) => toggleCcSwitchSite(current, engine, siteId, false),
    { ...settings, sites },
  );
  return {
    ...next,
    enabled:
      next.enabled &&
      CC_SWITCH_ENGINES.some((engine) => ccSwitchEngineSiteIds(next, engine).length > 0),
  };
}

export function addCcSwitchSite(
  settings: CcSwitchSettings,
  site: CcSwitchSite,
  configuredSiteIds: readonly string[],
): CcSwitchSettings {
  const sites = [...ccSwitchSites(settings), site];
  return CC_SWITCH_ENGINES.reduce<CcSwitchSettings>(
    (current, engine) => {
      const existing = ccSwitchEngineSiteIds(current, engine).filter((id) =>
        configuredSiteIds.includes(id),
      );
      return existing.length || current[engine.sitesField]?.length === 0
        ? current
        : {
            ...current,
            [engine.sitesField]: [site.id],
            [engine.siteField]: site.id,
            [engine.modelField]: "",
          };
    },
    { ...settings, sites },
  );
}

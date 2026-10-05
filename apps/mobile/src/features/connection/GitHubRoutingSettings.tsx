import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  gitHubRoutingConnectionKey,
  gitHubRoutingPermissionFor,
  type GitHubRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { t } from "@t3tools/shared/i18n";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const options: ReadonlyArray<{
  value: GitHubRoutingPermission;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: t("connection.gitHubRoutingSettings.offLabel"),
    description: t("connection.gitHubRoutingSettings.offDescription"),
  },
  {
    value: "read",
    label: t("connection.gitHubRoutingSettings.readPrsLabel"),
    description: t("connection.gitHubRoutingSettings.readPrsDescription"),
  },
  {
    value: "read-write",
    label: t("connection.gitHubRoutingSettings.readAndActLabel"),
    description: t("connection.gitHubRoutingSettings.readAndActDescription"),
  },
];

export function GitHubRoutingSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const permissions = useAtomValue(environmentCatalog.githubRoutingPermissionsValueAtom);
  const update = useAtomCommand(environmentCatalog.setGitHubRoutingPermission);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (catalog.entries.size === 0) return null;

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={t("connection.gitHubRoutingSettings.title")}>
        {[...catalog.entries.values()].map((entry) => {
          const environmentId = entry.target.environmentId;
          const selected = gitHubRoutingPermissionFor(entry, permissions);
          const disabled = !catalog.isReady || saving || gitHubRoutingConnectionKey(entry) === null;
          return (
            <View key={environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("connection.gitHubRoutingSettings.environmentLabel", {
                  label: entry.target.label,
                })}
                accessibilityState={{ expanded: expanded === environmentId }}
                className="flex-row items-center gap-3 p-4"
                onPress={() => setExpanded(expanded === environmentId ? null : environmentId)}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-bold text-foreground">
                    {entry.target.label}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {connectionCatalogDisplayUrl(entry) ?? "T3 Connect"}
                  </Text>
                </View>
                <Text className="text-sm text-foreground-muted">
                  {options.find((option) => option.value === selected)?.label}
                </Text>
                <SymbolView
                  name={expanded === environmentId ? "chevron.up" : "chevron.down"}
                  size={12}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
              {expanded === environmentId
                ? options.map((option) => (
                    <Pressable
                      key={option.value}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected === option.value, disabled }}
                      disabled={disabled}
                      className="flex-row items-center gap-4 p-4 disabled:opacity-50"
                      onPress={() => {
                        setSaving(true);
                        void update({ environmentId, permission: option.value }).then((result) => {
                          setSaving(false);
                          if (result._tag === "Failure")
                            Alert.alert(
                              t("connection.gitHubRoutingSettings.saveFailedTitle"),
                              t("connection.gitHubRoutingSettings.saveFailedBody"),
                            );
                        });
                      }}
                    >
                      <View className="min-w-0 flex-1 gap-1">
                        <Text className="text-base text-foreground">{option.label}</Text>
                        <Text className="text-sm leading-normal text-foreground-muted">
                          {option.description}
                        </Text>
                      </View>
                      {selected === option.value ? (
                        <SymbolView
                          name="checkmark"
                          size={18}
                          tintColorClassName="accent-icon"
                          weight="semibold"
                        />
                      ) : null}
                    </Pressable>
                  ))
                : null}
            </View>
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t("connection.gitHubRoutingSettings.description")}
      </Text>
    </View>
  );
}

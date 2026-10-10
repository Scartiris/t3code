import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

// Keep the old route usable for existing navigation links.
export function SettingsProviderAccountsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="CC Switch" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <View>
            <Text className="text-foreground-muted">
              选择环境，管理各站点的地址、Key 和引擎模型。
            </Text>
          </View>
          {selectedTargets.map((environment) => (
            <SettingsSection key={environment.environmentId} title={environment.label}>
              <SettingsActionRow
                icon="server.rack"
                label="站点与模型"
                onPress={() =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: {
                      screen: "SettingsCcSwitch",
                      params: { environmentId: environment.environmentId },
                    },
                  })
                }
              />
            </SettingsSection>
          ))}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

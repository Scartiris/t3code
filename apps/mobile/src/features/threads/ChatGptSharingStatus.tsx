import type { ServerProvider } from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { t } from "@t3tools/shared/i18n";
import { Alert, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";

export function ChatGptSharingStatus({ provider }: { provider: ServerProvider | null }) {
  if (!usesChatGptSharing(provider)) return null;
  return (
    <View className="flex-row items-center justify-between gap-3 px-3 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("threads.chatGptSharingStatus.tokenSharingActive")}
        className="min-h-11 flex-row items-center gap-2"
        onPress={() => {
          Alert.alert(
            t("threads.chatGptSharingStatus.sharingOnTitle"),
            [provider?.auth.email, t("threads.chatGptSharingStatus.sharingOnBody")]
              .filter(Boolean)
              .join("\n\n"),
          );
        }}
      >
        <ProviderIcon provider="codex" size={14} />
        <Text className="text-xs text-foreground-muted">
          {t("threads.chatGptSharingStatus.usingPlan")}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        className="min-h-11 justify-center"
        onPress={() => void Linking.openURL(CHATGPT_USAGE_URL).catch(() => undefined)}
      >
        <Text className="text-xs font-t3-medium text-primary">
          {t("threads.chatGptSharingStatus.manageUsage")}
        </Text>
      </Pressable>
    </View>
  );
}

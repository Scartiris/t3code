import { RequestActionButton } from "./RequestActionButton";
import { View } from "react-native";

import { t } from "@t3tools/shared/i18n";
import { AppText as Text } from "../../components/AppText";

/**
 * Shown in place of the composer when the server rejected a new task. The
 * prompt and attachments are already back in the project draft, so the only
 * action is reopening it.
 */
export function ThreadCreationFailedCard(props: {
  readonly reason: string;
  readonly onEditTask: () => void;
}) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-border-subtle bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground">
        {t("threads.threadCreationFailedCard.couldNotStartTask")}
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.reason}
      </Text>
      <Text className="font-sans text-xs leading-normal text-foreground-secondary">
        {t("threads.threadCreationFailedCard.promptKept")}
      </Text>
      <View className="flex-row">
        <RequestActionButton
          label={t("threads.threadCreationFailedCard.editTask")}
          onPress={props.onEditTask}
        />
      </View>
    </View>
  );
}

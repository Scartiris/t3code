import { useNavigation } from "@react-navigation/native";
import { t } from "@t3tools/shared/i18n";
import { useCallback } from "react";
import { Alert } from "react-native";

import { removeThreadOutboxMessage } from "../../state/thread-outbox-removal";
import { clearComposerDraftContent } from "../../state/use-composer-drafts";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { releaseEditingQueuedMessage } from "../../state/use-thread-outbox";

export function usePendingTaskListActions(): {
  readonly openPendingTask: (pendingTask: PendingNewTask) => void;
  readonly confirmDeletePendingTask: (pendingTask: PendingNewTask) => void;
} {
  const navigation = useNavigation();

  const openPendingTask = useCallback(
    (pendingTask: PendingNewTask) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(pendingTask.environmentId),
          projectId: String(pendingTask.projectId),
          ...(pendingTask.kind === "pending"
            ? { pendingTaskId: String(pendingTask.message.messageId) }
            : { draftId: pendingTask.draftKey }),
        },
      });
    },
    [navigation],
  );

  const confirmDeletePendingTask = useCallback((pendingTask: PendingNewTask) => {
    if (pendingTask.kind === "draft") {
      Alert.alert(
        t("home.usePendingTaskListActions.discardDraftTitle"),
        t("home.usePendingTaskListActions.discardDraftMessage", { title: pendingTask.title }),
        [
          { text: t("action.cancel"), style: "cancel" },
          {
            text: t("threads.threadListV2Items.discard"),
            style: "destructive",
            onPress: () => {
              // Same reset a submit performs: the next task in this project
              // re-resolves project defaults instead of inheriting the pick.
              clearComposerDraftContent(pendingTask.draftKey, {
                clearModelSelection: true,
                clearWorkspaceSelection: true,
              });
            },
          },
        ],
      );
      return;
    }
    Alert.alert(
      t("home.usePendingTaskListActions.deletePendingTaskTitle"),
      t("home.usePendingTaskListActions.deletePendingTaskMessage", { title: pendingTask.title }),
      [
        { text: t("action.cancel"), style: "cancel" },
        {
          text: t("threads.threadListV2Items.delete"),
          style: "destructive",
          onPress: () => {
            // Release the edit lock only after removal succeeds, and only if
            // it is held for THIS task — clearing it up front (or for another
            // task) would let the drain deliver a mid-edit payload.
            void removeThreadOutboxMessage(pendingTask.message)
              .then(() => releaseEditingQueuedMessage(pendingTask.message.messageId))
              .catch((error) => {
                Alert.alert(
                  t("home.usePendingTaskListActions.couldNotDeletePendingTask"),
                  error instanceof Error
                    ? error.message
                    : t("home.usePendingTaskListActions.pendingTaskCouldNotBeRemoved"),
                );
              });
          },
        },
      ],
    );
  }, []);

  return { openPendingTask, confirmDeletePendingTask };
}

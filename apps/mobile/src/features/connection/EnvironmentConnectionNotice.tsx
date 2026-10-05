import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/AppSymbol";
import { t } from "@t3tools/shared/i18n";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return t("connection.environmentConnectionNotice.offline");
    case "connecting":
      return t("connection.environmentConnectionNotice.connecting", { environmentLabel });
    case "reconnecting":
      return t("connection.environmentConnectionNotice.reconnecting", { environmentLabel });
    case "unsupported":
      return t("connection.environmentConnectionNotice.unsupported");
    case "error":
      return t("connection.environmentConnectionNotice.unavailable", { environmentLabel });
    case "available":
      return t("connection.environmentConnectionNotice.disconnected", { environmentLabel });
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return phase === "reconnecting"
      ? t("connection.environmentConnectionNotice.retryingWithError", { error })
      : error;
  }

  switch (phase) {
    case "offline":
      return t("connection.environmentConnectionNotice.offlineDetail", { resourceName });
    case "connecting":
    case "reconnecting":
      return t("connection.environmentConnectionNotice.pendingDetail", { resourceName });
    case "unsupported":
      return t("connection.environmentConnectionNotice.unsupportedDetail");
    case "available":
    case "error":
      return t("connection.environmentConnectionNotice.reconnectDetail", { resourceName });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onRetry}
          >
            <Text className="text-sm font-t3-bold text-foreground">
              {t("connection.environmentConnectionNotice.retryNow")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

import { AppText as Text } from "../../components/AppText";
import { t } from "@t3tools/shared/i18n";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

/** Inline trace control; disclosure rows reserve ordinary taps for their own navigation. */
export function ConnectionTraceId({
  traceId,
  tone = "muted",
  activation = "press",
}: {
  readonly traceId: string;
  readonly tone?: "muted" | "danger";
  readonly activation?: "press" | "longPress";
}) {
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <>
      {t("connection.connectionTraceId.prefix")}
      <Text
        accessibilityHint={
          activation === "longPress"
            ? t("connection.connectionTraceId.copyHintLongPress")
            : t("connection.connectionTraceId.copyHint")
        }
        accessibilityLabel={t("connection.connectionTraceId.copyLabel", { traceId })}
        accessibilityRole="button"
        accessibilityActions={[
          { name: "activate", label: t("connection.connectionTraceId.copyAction") },
        ]}
        onAccessibilityAction={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.actionName === "activate") copy();
        }}
        className={cn(
          "underline decoration-dotted",
          tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
        )}
        onLongPress={
          activation === "longPress"
            ? (event) => {
                event.stopPropagation();
                copy();
              }
            : undefined
        }
        onPress={(event) => {
          event.stopPropagation();
          if (activation === "press") copy();
        }}
      >
        {traceId}
      </Text>
    </>
  );
}

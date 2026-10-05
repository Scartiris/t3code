import { HStack, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  progressViewStyle,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

type UsageConfiguration = {
  codexPeriod?: "auto" | "session" | "weekly";
  claudePeriod?: "auto" | "session" | "weekly";
};

function SubscriptionUsage(
  props: SubscriptionUsageProps,
  environment: WidgetEnvironment<UsageConfiguration>,
) {
  "widget";
  // The extension evaluates this function without the app's module scope, so
  // localized copy is written inline here instead of through the i18n catalog:
  // an imported `t()` is a free identifier at render time and would throw.
  const family = environment.widgetFamily;
  // Gallery snapshots can render an old timeline entry after it has expired.
  const now = Math.max(environment.date?.getTime() ?? 0, Date.now());
  const accessory = family === "accessoryRectangular";
  const compact =
    family === "systemSmall" || accessory || environment.levelOfDetail === "simplified";
  // Budget short cards for two quotas per provider, including their secondary text.
  const dense = family === "systemSmall" || family === "systemMedium";
  const limit = family === "systemExtraLarge" ? 6 : family === "systemLarge" ? 4 : 2;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
  const providers = props.providers ?? [
    { name: "Codex", detail: "打开 T3 以连接", windows: [], expiresAt: 0 },
    { name: "Claude", detail: "打开 T3 以连接", windows: [], expiresAt: 0 },
  ];
  const columns = providers.map((provider) => {
    const stale = provider.windows.length > 0 && now >= provider.expiresAt;
    const period =
      environment.configuration?.[provider.name === "Claude" ? "claudePeriod" : "codexPeriod"] ??
      "auto";
    const windows = stale
      ? []
      : provider.windows.filter((window) => period === "auto" || window.kind === period);
    // Lock Screen widgets surface the tightest selected limit.
    const tightest = windows.reduce<(typeof windows)[number] | undefined>(
      (result, window) => (!result || window.remaining < result.remaining ? window : result),
      undefined,
    );
    const compactWindows = [
      windows.find((window) => window.kind === "session"),
      windows.find((window) => window.kind === "weekly"),
    ].filter((window) => window !== undefined);
    const shown =
      accessory || environment.levelOfDetail === "simplified"
        ? tightest
          ? [tightest]
          : []
        : family === "systemSmall" && compactWindows.length > 0
          ? compactWindows
          : period === "auto" && compactWindows.length > 0
            ? [
                ...compactWindows,
                ...windows.filter((window) => !compactWindows.includes(window)),
              ].slice(0, limit)
            : windows.slice(0, limit);
    const detail = stale
      ? "打开 T3 以刷新"
      : period !== "auto" && windows.length === 0 && provider.windows.length > 0
        ? `未报告${period === "weekly" ? "每周" : "会话"}限额`
        : provider.detail;
    const barModifiers = [
      progressViewStyle("linear"),
      frame({ height: 4 }),
      ...(monochrome ? [] : [tint(provider.name === "Claude" ? "#d97757" : "#8e8e93")]),
    ];
    if (accessory) {
      return (
        <VStack
          key={provider.name}
          alignment="leading"
          spacing={2}
          modifiers={[
            accessibilityElement("ignore"),
            accessibilityLabel(
              tightest
                ? `${provider.name}，${tightest.label}，剩余 ${tightest.remaining}%。${tightest.reset}。${provider.detail}。`
                : `${provider.name}。${detail}。`,
            ),
          ]}
        >
          <HStack spacing={4}>
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                foregroundStyle("primary"),
              ]}
            >
              {provider.name}
              {tightest ? ` · ${tightest.label}` : ""}
            </Text>
            <Spacer />
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                layoutPriority(1),
                foregroundStyle("primary"),
              ]}
            >
              {tightest
                ? `剩余 ${tightest.remaining}%`
                : period !== "auto" && !stale && provider.windows.length > 0
                  ? "不适用"
                  : "打开 T3"}
            </Text>
          </HStack>
          {tightest ? (
            <ProgressView value={tightest.remaining / 100} modifiers={barModifiers} />
          ) : null}
        </VStack>
      );
    }
    return (
      <VStack
        key={provider.name}
        alignment="leading"
        spacing={dense ? 1 : compact ? 2 : 4}
        modifiers={[
          frame({ maxWidth: Infinity, alignment: "leading" }),
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        <Text
          modifiers={[
            font({ textStyle: compact ? "caption" : "headline", weight: "bold" }),
            lineLimit(1),
            foregroundStyle("primary"),
          ]}
        >
          {provider.name}
        </Text>
        {!compact || shown.length === 0 ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            {detail === "Subscription remaining" ? " " : detail}
          </Text>
        ) : null}
        {shown.map((window) => (
          <VStack
            key={window.label}
            alignment="leading"
            spacing={dense ? 1 : 2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                `${provider.name}，${window.label}，剩余 ${window.remaining}%。${window.reset}。${provider.detail}。`,
              ),
            ]}
          >
            <HStack spacing={4}>
              <Text
                modifiers={[
                  font({ textStyle: compact || dense ? "caption2" : "caption" }),
                  foregroundStyle("secondary"),
                  lineLimit(1),
                ]}
              >
                {window.label}
              </Text>
              <Spacer />
              <Text
                modifiers={[
                  font({
                    textStyle: compact || dense ? "caption2" : "caption",
                    weight: "semibold",
                  }),
                  lineLimit(1),
                  layoutPriority(1),
                  foregroundStyle(
                    window.remaining <= 10 && !monochrome
                      ? environment.colorScheme === "light"
                        ? "#dc2626"
                        : "#fca5a5"
                      : "primary",
                  ),
                ]}
              >
                剩余 {window.remaining}%
              </Text>
            </HStack>
            <ProgressView value={window.remaining / 100} modifiers={barModifiers} />
            {!compact ? (
              <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
                {window.reset}
              </Text>
            ) : null}
          </VStack>
        ))}
        {!compact &&
        !stale &&
        (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) > limit ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            T3 中还有{" "}
            {(period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) -
              limit}{" "}
            项
          </Text>
        ) : null}
      </VStack>
    );
  });
  return (
    <VStack
      alignment="leading"
      spacing={accessory || dense ? 2 : 6}
      modifiers={props.url ? [widgetURL(props.url)] : []}
    >
      {providers.length === 0 ? (
        <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle("secondary")]}>
          没有可用的订阅限额。
        </Text>
      ) : compact ? (
        <VStack alignment="leading" spacing={accessory || dense ? 4 : 8}>
          {columns}
        </VStack>
      ) : (
        <HStack alignment="top" spacing={16}>
          {columns}
        </HStack>
      )}
      {!accessory ? <Spacer /> : null}
      {!accessory ? (
        <Text
          modifiers={[font({ textStyle: "caption2" }), foregroundStyle("secondary"), lineLimit(1)]}
        >
          {props.checkedAt
            ? `截至 ${new Date(props.checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`
            : "在 T3 中轻点以连接"}
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);

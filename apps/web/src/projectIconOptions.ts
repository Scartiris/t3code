import { t } from "@t3tools/shared/i18n";
import { iconNames, type IconName } from "lucide-react/dynamic";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_PROJECT_ICONS = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
] as const satisfies ReadonlyArray<IconName>;

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> = [
  { emoji: "💻", label: t("web.projectIconOptions.computer") },
  { emoji: "🛠️", label: t("web.projectIconOptions.tools") },
  { emoji: "🚀", label: t("web.projectIconOptions.rocket") },
  { emoji: "🤖", label: t("web.projectIconOptions.robot") },
  { emoji: "✨", label: t("web.projectIconOptions.sparkles") },
  { emoji: "⚡", label: t("web.projectIconOptions.lightning") },
  { emoji: "🌐", label: t("web.projectIconOptions.web") },
  { emoji: "📱", label: t("web.projectIconOptions.mobile") },
  { emoji: "🖥️", label: t("web.projectIconOptions.desktop") },
  { emoji: "⌨️", label: t("web.projectIconOptions.keyboard") },
  { emoji: "⚙️", label: t("web.projectIconOptions.gear") },
  { emoji: "🗄️", label: t("web.projectIconOptions.database") },
  { emoji: "☁️", label: t("web.projectIconOptions.cloud") },
  { emoji: "📦", label: t("web.projectIconOptions.package") },
  { emoji: "📚", label: t("web.projectIconOptions.books") },
  { emoji: "🧪", label: t("web.projectIconOptions.testTube") },
  { emoji: "🔒", label: t("web.projectIconOptions.lock") },
  { emoji: "🎮", label: t("web.projectIconOptions.game") },
  { emoji: "🎵", label: t("web.projectIconOptions.music") },
  { emoji: "🎬", label: t("web.projectIconOptions.movie") },
  { emoji: "🖼️", label: t("web.projectIconOptions.picture") },
  { emoji: "🛍️", label: t("web.projectIconOptions.shopping") },
  { emoji: "🔥", label: t("web.projectIconOptions.fire") },
  { emoji: "💡", label: t("web.projectIconOptions.idea") },
  { emoji: "🧩", label: t("web.projectIconOptions.puzzle") },
  { emoji: "📊", label: t("web.projectIconOptions.chart") },
  { emoji: "🧠", label: t("web.projectIconOptions.brain") },
  { emoji: "🦄", label: t("web.projectIconOptions.unicorn") },
  { emoji: "🐙", label: t("web.projectIconOptions.octopus") },
  { emoji: "🌱", label: t("web.projectIconOptions.seedling") },
];

export function filterProjectIconNames(query: string): ReadonlyArray<IconName> {
  const normalized = query.trim().toLowerCase().replaceAll(/\s+/g, "-");
  if (!normalized) return POPULAR_PROJECT_ICONS;
  return iconNames.filter((name) => name.includes(normalized)).slice(0, 60);
}

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment ?? "");
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) {
    return null;
  }
  return segment;
}

import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return t("preview.fileExplorerLabel.revealInFinder");
  if (normalized.includes("win")) return t("preview.fileExplorerLabel.revealInFileExplorer");
  return t("preview.fileExplorerLabel.revealInFiles");
}

/** Same wording keyed by an environment's reported OS rather than a
    navigator platform string, for actions that reveal on the server machine. */
export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return t("preview.fileExplorerLabel.revealInFinder");
  if (os === "windows") return t("preview.fileExplorerLabel.revealInFileExplorer");
  return t("preview.fileExplorerLabel.revealInFiles");
}

/** Server-selected wording, including Windows File Explorer reached from WSL. */
export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return t("preview.fileExplorerLabel.revealInFinder");
  if (kind === "file-explorer") return t("preview.fileExplorerLabel.revealInFileExplorer");
  return t("preview.fileExplorerLabel.revealInFiles");
}

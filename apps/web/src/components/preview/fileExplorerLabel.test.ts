import { t } from "@t3tools/shared/i18n";
import { describe, expect, it } from "vite-plus/test";

import {
  revealInFileExplorerLabel,
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./fileExplorerLabel";

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", t("preview.fileExplorerLabel.revealInFinder")],
    ["Win32", t("preview.fileExplorerLabel.revealInFileExplorer")],
    ["Linux x86_64", t("preview.fileExplorerLabel.revealInFiles")],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});

describe("revealInFileExplorerLabelForOs", () => {
  it.each([
    ["darwin", t("preview.fileExplorerLabel.revealInFinder")],
    ["windows", t("preview.fileExplorerLabel.revealInFileExplorer")],
    ["linux", t("preview.fileExplorerLabel.revealInFiles")],
    ["unknown", t("preview.fileExplorerLabel.revealInFiles")],
  ] as const)("maps %s to %s", (os, expected) => {
    expect(revealInFileExplorerLabelForOs(os)).toBe(expected);
  });
});

describe("revealInFileExplorerLabelForKind", () => {
  it.each([
    ["finder", t("preview.fileExplorerLabel.revealInFinder")],
    ["file-explorer", t("preview.fileExplorerLabel.revealInFileExplorer")],
    ["files", t("preview.fileExplorerLabel.revealInFiles")],
  ] as const)("maps %s to %s", (kind, expected) => {
    expect(revealInFileExplorerLabelForKind(kind)).toBe(expected);
  });
});

import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import {
  mediaReferenceFileName,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useCallback, useRef, useState, type ReactElement } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { downloadMedia, readMediaPng } from "./mediaContent";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}

function mediaFileName(source: MediaActionSource): string {
  return (
    (source.reference && mediaReferenceFileName(source.reference)) || source.name || source.kind
  );
}

/** Explicit byte operations get fresh capabilities without replacing a player's active source. */
function useMediaActions(source: MediaActionSource) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const actionUrl = useCallback(async () => {
    if (!source.asset) {
      if (!source.src) throw new Error(t("media.mediaActions.mediaUnavailable"));
      return source.src;
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error(t("media.mediaActions.reconnectEnvironment"));
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error(t("media.mediaActions.invalidMediaUrl"));
    return url;
  }, [source, createAssetUrl]);
  const save = useCallback(async () => {
    await downloadMedia(await actionUrl(), mediaFileName(source));
  }, [actionUrl, source]);
  const copyImage = useCallback(async () => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(t("media.mediaActions.copyImageUnavailable"));
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": actionUrl().then(readMediaPng) }),
    ]);
  }, [actionUrl]);
  return { save, copyImage };
}

/** Adds source-aware actions and a tooltip to the existing media element without a layout wrapper. */
export function MediaActions({
  source,
  children,
}: {
  source: MediaActionSource;
  children: ReactElement;
}) {
  const { save, copyImage } = useMediaActions(source);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = t("media.mediaActions.openMenuFailed");
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    try {
      const noun =
        source.kind === "image"
          ? t("media.mediaActions.imageNoun")
          : t("media.mediaActions.videoNoun");
      const unavailable = source.src === null && source.asset === undefined;
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: t("media.mediaActions.copyFullPath") });
        if (reference.relativePath)
          items.push({
            id: "copy-relative-path",
            label: t("media.mediaActions.copyRelativePath"),
          });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: t("desktop.contextMenu.copyLink") });
      }
      if (source.onOpenFile)
        items.push({ id: "open-file", label: t("media.mediaActions.openInFileViewer") });
      items.push({
        id: "save",
        label: t("media.mediaActions.saveMedia", { noun }),
        disabled: unavailable,
      });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: t("desktop.contextMenu.copyImage"),
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position);
      if (!action) return;
      failureTitle = t("media.mediaActions.actionFailedTitle", {
        action:
          items.find((item) => item.id === action)?.label.toLowerCase() ??
          t("media.mediaActions.completeMediaAction"),
      });
      const text =
        action === "copy-full-path" && reference?.kind === "file"
          ? reference.path
          : action === "copy-relative-path" && reference?.kind === "file"
            ? reference.relativePath
            : action === "copy-url" && reference?.kind === "url"
              ? reference.url
              : undefined;
      if (text !== undefined) {
        await writeTextToClipboard(
          text,
          reference?.kind === "file" ? t("media.mediaActions.filePath") : "URL",
        );
        toastManager.add({
          type: "success",
          title:
            action === "copy-url"
              ? t("media.mediaActions.urlCopied")
              : t("media.mediaActions.pathCopied"),
        });
      } else if (action === "open-file") {
        source.onOpenFile?.();
      } else if (action === "save" || action === "copy-image") {
        progressToast = toastManager.add({
          type: "loading",
          title:
            action === "save"
              ? t("media.mediaActions.preparingDownload", { noun })
              : t("media.mediaActions.copyingImage"),
        });
        await (action === "save" ? save() : copyImage());
        toastManager.update(progressToast, {
          type: "success",
          title:
            action === "save"
              ? t("media.mediaActions.downloadStarted")
              : t("media.mediaActions.imageCopied"),
        });
      }
    } catch (error) {
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : t("media.mediaActions.actionFailed"),
      });
      if (progressToast) toastManager.update(progressToast, toast);
      else toastManager.add(toast);
    } finally {
      menuOpen.current = false;
    }
  };

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        render={children}
        tabIndex={0}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            event.clientX === 0 && event.clientY === 0
              ? { x: bounds.left, y: bounds.bottom }
              : { x: event.clientX, y: event.clientY },
          );
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu({ x: bounds.left, y: bounds.bottom });
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

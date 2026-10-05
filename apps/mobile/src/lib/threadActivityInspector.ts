import type { V2ItemSupport } from "@t3tools/client-runtime/state/item-support";
import { toolItemForDisplay } from "@t3tools/client-runtime/work-log/presentation";
import type { ThreadId } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import type { ThreadFeedActivity } from "./threadActivity";

export interface ThreadActivityInspectorField {
  readonly label: string;
  readonly value: string;
}

export interface ThreadActivityInspectorBlock {
  readonly label: string;
  readonly value: string;
  readonly monospaced: boolean;
}

export interface ThreadActivityFileLink {
  readonly label: string;
  readonly path: string;
  readonly line?: number;
}

export interface ThreadActivityWebLink {
  readonly label: string;
  readonly url: string;
}

export interface ThreadActivityInspectorModel {
  readonly fields: ReadonlyArray<ThreadActivityInspectorField>;
  readonly blocks: ReadonlyArray<ThreadActivityInspectorBlock>;
  readonly fileLinks: ReadonlyArray<ThreadActivityFileLink>;
  readonly webLinks: ReadonlyArray<ThreadActivityWebLink>;
  readonly canRollback: boolean;
  readonly rollbackTarget: {
    readonly threadId: ThreadId;
    readonly checkpointId: string;
    readonly scopeId: string;
  } | null;
  readonly structuredDetails: string;
}

function formatStructured(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function durationLabel(
  startedAt: DateTime.Utc | null,
  completedAt: DateTime.Utc | null,
): string | null {
  if (startedAt === null) return null;
  const start = DateTime.toEpochMillis(startedAt);
  const end = completedAt === null ? Date.now() : DateTime.toEpochMillis(completedAt);
  return formatDuration(Math.max(0, end - start));
}

function addBlock(
  blocks: ThreadActivityInspectorBlock[],
  label: string,
  value: unknown,
  monospaced = true,
): void {
  if (value === undefined || value === null || value === "") return;
  blocks.push({ label, value: formatStructured(value), monospaced });
}

export function buildThreadActivityInspector(
  activity: Pick<ThreadFeedActivity, "projectedItem">,
  support: V2ItemSupport,
  currentThreadId: ThreadId,
): ThreadActivityInspectorModel {
  const row = activity.projectedItem;
  const item = row.item;
  const fields: ThreadActivityInspectorField[] = [
    { label: t("threads.threadActivityInspector.item"), value: item.type.replaceAll("_", " ") },
    { label: t("threads.threadActivityInspector.status"), value: item.status.replaceAll("_", " ") },
  ];
  const duration = durationLabel(item.startedAt, item.completedAt);
  if (duration)
    fields.push({ label: t("threads.threadActivityInspector.duration"), value: duration });
  if (row.visibility !== "local")
    fields.push({ label: t("threads.threadActivityInspector.visibility"), value: row.visibility });
  if (support.run)
    fields.push({ label: t("threads.threadActivityInspector.run"), value: support.run.status });

  const latestAttempt = support.attempts.at(-1);
  if (latestAttempt) {
    fields.push({
      label: t("threads.threadActivityInspector.attempt"),
      value: `${latestAttempt.attemptOrdinal} · ${latestAttempt.status} · ${latestAttempt.reason.replaceAll("_", " ")}`,
    });
  }
  if (support.node) {
    fields.push({
      label: t("threads.threadActivityInspector.node"),
      value: `${support.node.kind.replaceAll("_", " ")} · ${support.node.status}`,
    });
  }
  if (support.providerThread) {
    fields.push({
      label: t("threads.threadActivityInspector.providerThread"),
      value: `${support.providerThread.providerInstanceId} · ${support.providerThread.status}`,
    });
  }
  if (support.providerTurn) {
    fields.push({
      label: t("threads.threadActivityInspector.providerTurn"),
      value: support.providerTurn.status,
    });
  }
  if (support.providerSession) {
    fields.push({
      label: t("threads.threadActivityInspector.session"),
      value: `${support.providerSession.status} · ${support.providerSession.model ?? t("threads.threadActivityInspector.defaultModel")}`,
    });
    fields.push({
      label: t("threads.threadActivityInspector.workingDirectory"),
      value: support.providerSession.cwd,
    });
  }
  if (support.runtimeRequest) {
    fields.push({
      label: t("threads.threadActivityInspector.request"),
      value: `${support.runtimeRequest.status} · ${support.runtimeRequest.responseCapability.type.replaceAll("_", " ")}`,
    });
  }

  const blocks: ThreadActivityInspectorBlock[] = [];
  const fileLinks: ThreadActivityFileLink[] = [];
  const webLinks: ThreadActivityWebLink[] = [];

  if (support.attempts.length > 1) {
    addBlock(
      blocks,
      t("threads.threadActivityInspector.attemptHistory"),
      support.attempts
        .map((attempt) =>
          t("threads.threadActivityInspector.attemptLine", {
            ordinal: attempt.attemptOrdinal,
            status: attempt.status,
            reason: attempt.reason.replaceAll("_", " "),
          }),
        )
        .join("\n"),
    );
  }

  switch (item.type) {
    case "reasoning":
      addBlock(blocks, t("threads.threadActivityInspector.reasoning"), item.text, false);
      break;
    case "command_execution":
      addBlock(blocks, t("threads.threadActivityInspector.command"), item.input);
      if (item.exitCode !== undefined) {
        addBlock(
          blocks,
          t("threads.threadActivityInspector.exit"),
          t("chat.v2ItemInspector.processExited", { code: item.exitCode }),
        );
      }
      break;
    case "file_change":
      for (const change of item.changes ?? [{ path: item.fileName, operation: "modify" }]) {
        fileLinks.push({
          label: `${change.operation} ${change.oldPath ? `${change.oldPath} → ` : ""}${change.path}`,
          path: change.path,
        });
      }
      if (item.additions !== undefined || item.deletions !== undefined) {
        fields.push({
          label: t("threads.threadActivityInspector.changes"),
          value: `+${item.additions ?? 0} −${item.deletions ?? 0}`,
        });
      }
      break;
    case "file_search":
      addBlock(blocks, t("threads.threadActivityInspector.query"), item.pattern);
      for (const result of item.results ?? []) {
        fileLinks.push({
          label: result.preview ? `${result.fileName} — ${result.preview}` : result.fileName,
          path: result.fileName,
          ...(result.line === undefined ? {} : { line: result.line }),
        });
      }
      break;
    case "web_search":
      addBlock(blocks, t("threads.threadActivityInspector.queries"), item.patterns?.join("\n"));
      for (const result of item.results ?? []) {
        if (result.url) {
          webLinks.push({
            label: result.title ?? result.url,
            url: result.url,
          });
        }
        if (result.snippet)
          addBlock(
            blocks,
            result.title ?? t("chat.v2ItemInspector.searchResult"),
            result.snippet,
            false,
          );
      }
      break;
    case "dynamic_tool":
      addBlock(blocks, t("chat.v2ItemInspector.input"), item.input);
      break;
    case "approval_request":
      addBlock(blocks, t("threads.threadActivityInspector.prompt"), item.prompt, false);
      break;
    case "user_input_request":
      addBlock(
        blocks,
        t("threads.threadActivityInspector.questions"),
        item.questions.map((question) => question.question).join("\n"),
        false,
      );
      break;
    case "checkpoint":
      addBlock(
        blocks,
        t("threads.threadActivityInspector.files"),
        item.files
          .map((file) => `${file.path}  +${file.additions} −${file.deletions}  ${file.kind}`)
          .join("\n"),
      );
      break;
    case "subagent":
      addBlock(blocks, t("threads.threadActivityInspector.prompt"), item.prompt, false);
      addBlock(
        blocks,
        t("threads.threadActivityInspector.progress"),
        support.subagent?.progress ?? item.progress,
        false,
      );
      addBlock(
        blocks,
        t("threads.threadActivityInspector.result"),
        support.subagent?.result ?? item.result,
        false,
      );
      if (support.subagent) {
        fields.push({
          label: t("threads.threadActivityInspector.delegatedTask"),
          value: `${support.subagent.origin.replaceAll("_", " ")} · ${support.subagent.status}`,
        });
      }
      break;
    case "handoff":
      addBlock(blocks, t("threads.threadActivityInspector.summary"), item.summary, false);
      fields.push({
        label: t("threads.threadActivityInspector.handoff"),
        value: `${item.strategy.replaceAll("_", " ")} · ${support.contextHandoff?.status ?? item.status}`,
      });
      if (support.contextTransfer) {
        fields.push({
          label: t("threads.threadActivityInspector.transfer"),
          value: `${support.contextTransfer.type.replaceAll("_", " ")} · ${support.contextTransfer.status}`,
        });
        if (support.contextTransfer.resolution) {
          fields.push({
            label: t("threads.threadActivityInspector.context"),
            value: support.contextTransfer.resolution.strategy.replaceAll("_", " "),
          });
        }
      }
      break;
    case "error":
      addBlock(blocks, t("threads.threadActivityInspector.error"), item.failure.message, false);
      if (item.failure.code)
        fields.push({ label: t("threads.threadActivityInspector.code"), value: item.failure.code });
      if (item.failure.retryable !== null) {
        fields.push({
          label: t("threads.threadActivityInspector.retryable"),
          value: item.failure.retryable
            ? t("threads.threadActivityInspector.yes")
            : t("threads.threadActivityInspector.no"),
        });
      }
      break;
    case "proposed_plan":
      addBlock(blocks, t("threads.threadActivityInspector.plan"), item.markdown, false);
      break;
    case "todo_list":
      addBlock(
        blocks,
        t("threads.threadActivityInspector.tasks"),
        item.steps
          .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
          .join("\n"),
        false,
      );
      addBlock(blocks, t("threads.threadActivityInspector.explanation"), item.explanation, false);
      break;
    case "compaction":
      addBlock(blocks, t("threads.threadActivityInspector.summary"), item.summary, false);
      if (item.beforeTokenCount !== undefined || item.afterTokenCount !== undefined) {
        fields.push({
          label: t("threads.threadActivityInspector.contextTokens"),
          value: `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"}`,
        });
      }
      break;
    case "run_interrupt_request":
    case "run_interrupt_result":
      addBlock(blocks, t("threads.threadActivityInspector.message"), item.message, false);
      break;
    case "fork":
    case "thread_created":
    case "user_message":
    case "assistant_message":
      break;
  }

  const checkpoint =
    item.type === "checkpoint" && row.sourceThreadId === currentThreadId
      ? support.checkpoint
      : null;
  return {
    fields,
    blocks,
    fileLinks,
    webLinks,
    canRollback: checkpoint?.status === "ready",
    rollbackTarget:
      checkpoint?.status === "ready"
        ? {
            threadId: row.sourceThreadId,
            checkpointId: checkpoint.id,
            scopeId: checkpoint.scopeId,
          }
        : null,
    structuredDetails: formatStructured({
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: toolItemForDisplay(item),
    }),
  };
}

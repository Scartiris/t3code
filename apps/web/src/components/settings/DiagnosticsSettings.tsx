import { ProcessSignalActions } from "./ProcessSignalActions";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AlertTriangleIcon, CopyIcon, FolderOpenIcon, InfoIcon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceHistorySummary,
  ServerProcessSignal,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { getRelativeTimeState } from "../../timestampFormat";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ExpandableText } from "./ExpandableText";
import { ResourceTelemetryDiagnostics } from "./ResourceTelemetryDiagnostics";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";

const NUMBER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRelative(value: DateTime.Utc | null): string {
  if (!value) return t("settings.diagnosticsSettings.noTraceRecords");
  const relative = getRelativeTimeState(DateTime.formatIso(value));
  if (relative.status !== "relative") return "";
  return relative.suffix
    ? t("settings.diagnosticsSettings.relativeAgo", { value: relative.value })
    : t("settings.diagnosticsSettings.relativeJustNow");
}

function formatRelativeNoWrap(value: DateTime.Utc | null): string {
  return formatRelative(value).replaceAll(" ", "\u00a0");
}

function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}

function isStaleProcessSignalMessage(message: string | undefined): boolean {
  return message?.includes("not a live descendant") ?? false;
}

function StatBlock({
  label,
  value,
  tooltip,
  tone = "default",
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 border-border/60 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-widest text-muted-foreground/70">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="cursor-pointer inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
                  aria-label={t("settings.diagnosticsSettings.statDetails", { label })}
                >
                  <InfoIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid grid-cols-2 sm:grid-cols-4">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/60"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border/60 sm:hidden"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      {children}
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

function DiagnosticsTable({
  headers,
  children,
  minTableWidth = "min-w-[640px]",
  columnWidths,
}: {
  headers: ReadonlyArray<string>;
  children: ReactNode;
  minTableWidth?: string;
  columnWidths?: ReadonlyArray<string>;
}) {
  return (
    <ScrollArea
      radius="none"
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full"
    >
      <table
        className={cn("w-full text-left text-xs", minTableWidth, columnWidths && "table-fixed")}
      >
        {columnWidths ? (
          <colgroup>
            {headers.map((header, index) => (
              <col key={header} className={columnWidths[index]} />
            ))}
          </colgroup>
        ) : null}
        <thead className="border-b border-border/60 text-2xs uppercase tracking-widest text-muted-foreground/70">
          <tr>
            {headers.map((header, index) => (
              <th
                key={header}
                className={cn(
                  "whitespace-nowrap px-4 py-2.5 font-semibold first:sm:pl-5 last:sm:pr-5",
                  !columnWidths && index === headers.length - 1 && "w-px",
                )}
              >
                {header.replaceAll(" ", "\u00a0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </ScrollArea>
  );
}

function TraceIdCell({ traceId }: { traceId: string }) {
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    target: "trace ID",
    timeout: 1_200,
  });

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">
              {shortenTraceId(traceId)}
            </span>
          }
        />
        <TooltipPopup side="top" variant="code">
          {traceId}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={
                copied
                  ? t("settings.diagnosticsSettings.copiedTraceId")
                  : t("settings.diagnosticsSettings.copyTraceId")
              }
              onClick={() => copyToClipboard(traceId)}
            >
              <CopyIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {copied
            ? t("settings.diagnosticsSettings.copied")
            : t("settings.diagnosticsSettings.copyFullTraceId")}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function formatProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function formatProcessType(process: ServerProcessDiagnosticsEntry): string {
  if (process.depth > 0) return t("settings.diagnosticsSettings.processTypeSubprocess");
  if (/\b(codex|claude|opencode|cursor)\b/i.test(process.command))
    return t("settings.diagnosticsSettings.processTypeAgent");
  return t("settings.diagnosticsSettings.process");
}

function ProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerProcessDiagnosticsEntry;
  isExpanded: boolean;
  onToggle: (pid: number) => void;
}) {
  const name = formatProcessName(process.command);
  const hasChildren = process.childPids.length > 0;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={
            isExpanded
              ? t("settings.diagnosticsSettings.collapseProcess", { name })
              : t("settings.diagnosticsSettings.expandProcess", { name })
          }
          onClick={() => onToggle(process.pid)}
        >
          <MorphIcon className="size-3.5" icon={isExpanded ? ChevronDown : ChevronRight} />
        </Button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-success/80" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessDiagnosticsTable({
  processes,
  signalingPid,
  onSignal,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>;
  signalingPid: number | null;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
  emptyLabel?: string;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = useMemo(() => {
    const visible: ServerProcessDiagnosticsEntry[] = [];
    let hiddenChildDepth: number | null = null;

    for (const process of processes) {
      if (hiddenChildDepth !== null) {
        if (process.depth > hiddenChildDepth) continue;
        hiddenChildDepth = null;
      }

      visible.push(process);
      if (collapsedPids.has(process.pid)) {
        hiddenChildDepth = process.depth;
      }
    }

    return visible;
  }, [collapsedPids, processes]);

  const toggleProcess = useCallback((pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        radius="none"
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(64vh,44rem)] w-full max-w-full"
      >
        <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
            <col className="w-[33%]" />
            <col className="w-[8%]" />
            <col className="w-[11%]" />
            <col className="w-[6%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-2xs uppercase tracking-widest text-muted-foreground/70">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                {t("settings.diagnosticsSettings.name")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.memory")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("settings.diagnosticsSettings.command")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">PID</th>
              <th className="px-3 py-2 font-semibold">{t("settings.diagnosticsSettings.type")}</th>
              <th className="p-2 text-right font-semibold sm:pr-4">
                {t("settings.diagnosticsSettings.kill")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visibleProcesses.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  {emptyLabel ?? t("settings.diagnosticsSettings.noLiveDescendantProcesses")}
                </td>
              </tr>
            ) : null}
            {visibleProcesses.map((process) => (
              <tr key={process.pid} className="hover:bg-muted/20">
                <td className="px-4 py-2 align-middle sm:pl-5">
                  <ProcessNameCell
                    process={process}
                    isExpanded={!collapsedPids.has(process.pid)}
                    onToggle={toggleProcess}
                  />
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatBytes(process.rssBytes)}
                </td>
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="block truncate">{process.command}</span>}
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                  {process.pid}
                </td>
                <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                  {formatProcessType(process)}
                </td>
                <td className="p-2 align-middle sm:pr-4">
                  <ProcessSignalActions
                    disabled={signalingPid === process.pid}
                    onSignal={(signal) => onSignal(process.pid, signal)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

const RESOURCE_HISTORY_WINDOWS = [
  {
    label: t("settings.diagnosticsSettings.historyWindow5m"),
    windowMs: 5 * 60_000,
    bucketMs: 30_000,
  },
  {
    label: t("settings.diagnosticsSettings.historyWindow15m"),
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
  },
  {
    label: t("settings.diagnosticsSettings.historyWindow30m"),
    windowMs: 30 * 60_000,
    bucketMs: 2 * 60_000,
  },
  {
    label: t("settings.diagnosticsSettings.historyWindow1h"),
    windowMs: 60 * 60_000,
    bucketMs: 5 * 60_000,
  },
] as const;

function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

function ResourceHistoryProcessNameCell({
  process,
  visualDepth,
}: {
  process: ServerProcessResourceHistorySummary;
  visualDepth: number;
}) {
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={
        process.isServerRoot
          ? t("settings.diagnosticsSettings.rootProcessAria", { name })
          : t("settings.diagnosticsSettings.childProcessAria", { name })
      }
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-warning/90" : "bg-success/80",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<{
    readonly startedAt: DateTime.Utc;
    readonly avgCpuPercent: number;
    readonly maxCpuPercent: number;
  }>;
}) {
  const maxCpuPercent = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex h-28 items-end gap-1 overflow-hidden rounded-sm bg-muted/10 p-2">
        {buckets.map((bucket) => {
          const peakHeight = Math.max(2, (bucket.maxCpuPercent / maxCpuPercent) * 100);
          const averageHeight = Math.max(2, (bucket.avgCpuPercent / maxCpuPercent) * 100);
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <div
                      className="relative h-full w-full"
                      aria-label={t("settings.diagnosticsSettings.cpuBucketAria", {
                        avg: bucket.avgCpuPercent.toFixed(1),
                        peak: bucket.maxCpuPercent.toFixed(1),
                      })}
                    >
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/15 transition-colors"
                        style={{ height: `${peakHeight}%` }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/60 transition-colors"
                        style={{ height: `${averageHeight}%` }}
                      />
                    </div>
                  </div>
                }
              />
              <TooltipPopup side="top">
                {t("settings.diagnosticsSettings.cpuBucketTooltip", {
                  avg: bucket.avgCpuPercent.toFixed(1),
                  peak: bucket.maxCpuPercent.toFixed(1),
                })}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ResourceHistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <ToggleGroup
      aria-label={t("settings.diagnosticsSettings.historyPeriodAria")}
      variant="segmented"
      value={[String(selectedWindowMs)]}
      onValueChange={(next) => {
        const selected = RESOURCE_HISTORY_WINDOWS.find(
          (option) => String(option.windowMs) === next[0],
        );
        if (selected) onSelect(selected.windowMs);
      }}
    >
      {RESOURCE_HISTORY_WINDOWS.map((option) => (
        <Toggle key={option.windowMs} value={String(option.windowMs)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ProcessResourceHistoryTable({
  processes,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessResourceHistorySummary>;
  emptyLabel: string;
}) {
  const shallowestChildDepth = processes.reduce<number | null>((minDepth, process) => {
    if (process.isServerRoot) return minDepth;
    return minDepth === null ? process.depth : Math.min(minDepth, process.depth);
  }, null);

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(64vh,44rem)] w-full max-w-full"
      >
        <table className="w-full min-w-[980px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[16%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-2xs uppercase tracking-widest text-muted-foreground/70">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                {t("settings.diagnosticsSettings.process")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.cpuTime")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.current")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.average")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.peak")}
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("settings.diagnosticsSettings.maxMem")}
              </th>
              <th className="px-3 py-2 font-semibold">
                {t("settings.diagnosticsSettings.command")}
              </th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  {emptyLabel}
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr key={process.processKey} className="hover:bg-muted/20">
                <td className="px-4 py-2 align-middle sm:pl-5">
                  <ResourceHistoryProcessNameCell
                    process={process}
                    visualDepth={
                      process.isServerRoot || shallowestChildDepth === null
                        ? 0
                        : Math.max(1, process.depth - shallowestChildDepth + 1)
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatCpuTime(process.cpuSecondsApprox)}
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.currentCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.avgCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatBytes(process.maxRssBytes)}
                </td>
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="block truncate">{process.command}</span>}
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground sm:pr-5">
                  {process.pid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function DiagnosticsLastChecked({ checkedAt }: { checkedAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  const relative = getRelativeTimeState(checkedAt ? DateTime.formatIso(checkedAt) : null);

  if (relative.status === "missing") {
    return (
      <span className="text-2xs text-muted-foreground/50">
        {t("settings.diagnosticsSettings.checking")}
      </span>
    );
  }

  if (relative.status === "invalid") {
    return (
      <span className="text-2xs text-muted-foreground/50">
        {t("settings.diagnosticsSettings.checkedUnavailable")}
      </span>
    );
  }

  return (
    <span className="text-2xs text-muted-foreground/60">
      {relative.suffix ? (
        <>
          {t("settings.diagnosticsSettings.checked")}{" "}
          <span className="font-mono tabular-nums">{relative.value}</span>{" "}
          {t("settings.diagnosticsSettings.checkedAgo")}
        </>
      ) : (
        <>{t("settings.diagnosticsSettings.checkedJustNow")}</>
      )}
    </span>
  );
}

function DiagnosticsRefreshButton({
  isPending,
  label,
  onClick,
}: {
  isPending: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={isPending}
            onClick={onClick}
            aria-label={label}
          >
            <RefreshIcon refreshing={isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DiagnosticsSettingsPanel() {
  const { environment } = useSettingsScope();
  // The boundary only mounts this page when the selection resolves to one
  // connected environment, so the representative is the one to inspect.
  const environmentId = environment?.environmentId ?? null;
  const observability = environment?.serverConfig?.observability;
  const availableEditors = environment?.serverConfig?.availableEditors;
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000);
  const selectedResourceWindow =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === resourceWindowMs) ??
    RESOURCE_HISTORY_WINDOWS[1];
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: resourceData,
    error: resourceError,
    isPending: isResourcePending,
    refresh: refreshResources,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.processResourceHistory({
          environmentId,
          input: {
            windowMs: selectedResourceWindow.windowMs,
            bucketMs: selectedResourceWindow.bucketMs,
          },
        }),
  );
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const signalingPidRef = useRef<number | null>(null);
  const environmentIdRef = useRef(environmentId);
  const processDataRef = useRef(processData);
  useEffect(() => {
    processDataRef.current = processData;
  }, [processData]);
  useEffect(() => {
    environmentIdRef.current = environmentId;
    return () => {
      environmentIdRef.current = null;
    };
  }, [environmentId]);

  const openLogsDirectory = useCallback(() => {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
    if (!logsDirectoryPath) return;

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenLogsDirectoryError(t("settings.diagnosticsSettings.noAvailableEditors"));
      return;
    }
    if (environmentId === null) {
      setOpenLogsDirectoryError(t("settings.diagnosticsSettings.noEnvironmentSelected"));
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void (async () => {
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: logsDirectoryPath,
          editor,
        },
      });
      setIsOpeningLogsDirectory(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setOpenLogsDirectoryError(
          error instanceof Error
            ? error.message
            : t("settings.diagnosticsSettings.unableToOpenLogsFolder"),
        );
      }
    })();
  }, [availableEditors, environmentId, observability?.logsDirectoryPath, openInEditor]);

  const isInitialLoading = isPending && data === null;
  const isProcessInitialLoading = isProcessPending && processData === null;
  const signalProcess = useCallback(
    async (pid: number, signal: ServerProcessSignal) => {
      const targetEnvironmentId = environmentIdRef.current;
      const process = processDataRef.current?.processes.find((entry) => entry.pid === pid);
      if (targetEnvironmentId === null || process === undefined) return;
      if (signalingPidRef.current !== null) return;
      signalingPidRef.current = pid;
      setSignalingPid(pid);
      const clearSignaling = () => {
        signalingPidRef.current = null;
        setSignalingPid(null);
      };
      if (signal === "SIGKILL") {
        let confirmed = false;
        try {
          confirmed = await ensureLocalApi().dialogs.confirm(
            t("settings.diagnosticsSettings.confirmSigkill", { pid }),
            { variant: "destructive" },
          );
        } catch (error) {
          clearSignaling();
          toastManager.add({
            type: "error",
            title: t("settings.diagnosticsSettings.couldNotConfirmSignal"),
            description:
              error instanceof Error
                ? error.message
                : t("settings.diagnosticsSettings.signalSendFailed", { signal }),
          });
          return;
        }
        if (!confirmed) {
          clearSignaling();
          return;
        }
      }
      if (environmentIdRef.current !== targetEnvironmentId) {
        clearSignaling();
        return;
      }
      if (
        processDataRef.current?.processes.find((entry) => entry.pid === pid)?.startTimeMs !==
        process.startTimeMs
      ) {
        clearSignaling();
        return;
      }

      try {
        const result = await signalServerProcess({
          environmentId: targetEnvironmentId,
          input: { pid, startTimeMs: process.startTimeMs, signal },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: t("settings.diagnosticsSettings.couldNotSendSignal", { signal }),
              description:
                error instanceof Error
                  ? error.message
                  : t("settings.diagnosticsSettings.signalSendFailed", { signal }),
            });
          }
          return;
        }
        if (!result.value.signaled) {
          const message = Option.getOrUndefined(result.value.message);
          refreshProcesses();
          if (isStaleProcessSignalMessage(message)) {
            toastManager.add({
              type: "info",
              title: t("settings.diagnosticsSettings.processAlreadyExited"),
              description: t("settings.diagnosticsSettings.processAlreadyExitedDescription"),
            });
            return;
          }

          toastManager.add({
            type: "error",
            title: t("settings.diagnosticsSettings.couldNotSendSignal", { signal }),
            description: message ?? t("settings.diagnosticsSettings.signalSendFailed", { signal }),
          });
          return;
        }
        refreshProcesses();
      } finally {
        clearSignaling();
      }
    },
    [refreshProcesses, signalServerProcess],
  );

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;

  return (
    <SettingsPageContainer width="expanded" className="gap-10">
      <ResourceTelemetryDiagnostics environmentId={environmentId} />

      <SettingsSection
        title={t("settings.diagnosticsSettings.liveProcesses")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={processData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isProcessPending}
              label={t("settings.diagnosticsSettings.refreshProcessDiagnostics")}
              onClick={refreshProcesses}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={t("settings.diagnosticsSettings.childProcesses")}
            value={processData ? formatCount(processData.processCount) : "..."}
          />
          <StatBlock
            label="CPU"
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : "..."}
            tooltip={t("settings.diagnosticsSettings.totalCpuTooltip")}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.memory")}
            value={processData ? formatBytes(processData.totalRssBytes) : "..."}
            tooltip={t("settings.diagnosticsSettings.totalMemoryTooltip")}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.serverPid")}
            value={processData ? String(processData.serverPid) : "..."}
          />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          emptyLabel={
            isProcessInitialLoading
              ? t("settings.diagnosticsSettings.loadingLiveProcesses")
              : t("settings.diagnosticsSettings.noLiveDescendantProcesses")
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.diagnosticsSettings.resourceHistory")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsLastChecked checkedAt={resourceData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label={t("settings.diagnosticsSettings.refreshResourceHistory")}
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={t("settings.diagnosticsSettings.cpuTime")}
            value={resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox) : "..."}
            tooltip={t("settings.diagnosticsSettings.totalCpuTimeTooltip")}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.samples")}
            value={resourceData ? formatCount(resourceData.retainedSampleCount) : "..."}
            tooltip={t("settings.diagnosticsSettings.samplesTooltip")}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.interval")}
            value={resourceData ? formatDuration(resourceData.sampleIntervalMs) : "..."}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.processes")}
            value={resourceData ? formatCount(resourceData.topProcesses.length) : "..."}
          />
        </StatsGrid>
        {processResourceError || resourceError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processResourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processResourceError.message}</span>
              </div>
            ) : null}
            {resourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{resourceError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessResourceHistoryChart buckets={resourceData?.buckets ?? []} />
        <ProcessResourceHistoryTable
          processes={resourceData?.topProcesses ?? []}
          emptyLabel={
            isResourcePending && resourceData === null
              ? t("settings.diagnosticsSettings.collectingResourceSamples")
              : t("settings.diagnosticsSettings.noResourceSamples")
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.diagnosticsSettings.traceDiagnostics")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!observability?.logsDirectoryPath || isOpeningLogsDirectory}
                    onClick={openLogsDirectory}
                    aria-label={t("settings.diagnosticsSettings.openLogsFolder")}
                  >
                    <FolderOpenIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {t("settings.diagnosticsSettings.openLogsFolder")}
              </TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label={t("settings.diagnosticsSettings.refreshTraceDiagnostics")}
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={t("settings.diagnosticsSettings.spans")}
            value={data ? formatCount(data.recordCount) : "..."}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.failures")}
            value={data ? formatCount(data.failureCount) : "..."}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.slowSpans")}
            value={data ? formatCount(data.slowSpanCount) : "..."}
            tooltip={
              data
                ? t("settings.diagnosticsSettings.slowSpanThresholdTooltip", {
                    duration: formatDuration(data.slowSpanThresholdMs),
                  })
                : t("settings.diagnosticsSettings.slowSpanThresholdDefaultTooltip")
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label={t("settings.diagnosticsSettings.parseErrors")}
            value={data ? formatCount(data.parseErrorCount) : "..."}
            tone={data && data.parseErrorCount > 0 ? "warning" : "default"}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  "flex items-start gap-2",
                  traceDiagnosticsPartialFailure ? "text-warning-foreground" : "text-destructive",
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? t("settings.diagnosticsSettings.partialTraceFailure", {
                        message: traceDiagnosticsError.message,
                      })
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settings.diagnosticsSettings.latestFailures")}>
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable
            headers={[
              t("settings.diagnosticsSettings.span"),
              t("settings.diagnosticsSettings.cause"),
              t("settings.diagnosticsSettings.duration"),
              t("settings.diagnosticsSettings.ended"),
            ]}
          >
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading
                ? t("settings.diagnosticsSettings.loadingFailures")
                : t("settings.diagnosticsSettings.noFailedSpans")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.diagnosticsSettings.mostCommonFailures")}>
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={[
              t("settings.diagnosticsSettings.span"),
              t("settings.diagnosticsSettings.count"),
              t("settings.diagnosticsSettings.cause"),
              t("settings.diagnosticsSettings.lastSeen"),
            ]}
            minTableWidth="min-w-[760px]"
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(failure.count)}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.lastSeenAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading
                ? t("settings.diagnosticsSettings.loadingFailureGroups")
                : t("settings.diagnosticsSettings.noRepeatedFailures")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.diagnosticsSettings.slowestSpans")}>
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={[
              t("settings.diagnosticsSettings.span"),
              t("settings.diagnosticsSettings.duration"),
              t("settings.diagnosticsSettings.ended"),
              t("settings.diagnosticsSettings.trace"),
            ]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading
                ? t("settings.diagnosticsSettings.loadingSlowSpans")
                : t("settings.diagnosticsSettings.noSpans")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.diagnosticsSettings.spanLogs")}>
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            radius="none"
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-2xs uppercase tracking-widest text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">
                    {t("settings.diagnosticsSettings.time")}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    {t("settings.diagnosticsSettings.level")}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    {t("settings.diagnosticsSettings.span")}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    {t("settings.diagnosticsSettings.message")}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">
                    {t("settings.diagnosticsSettings.trace")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {formatRelativeNoWrap(event.seenAt)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-2xs font-medium uppercase text-foreground/80">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel={t("settings.diagnosticsSettings.showFullMessage")}
                        text={event.message}
                      />
                    </td>
                    <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground sm:pr-5">
                      <TraceIdCell traceId={event.traceId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <EmptyRows
            label={
              isInitialLoading
                ? t("settings.diagnosticsSettings.loadingRecentLogs")
                : t("settings.diagnosticsSettings.noWarningsOrErrors")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.diagnosticsSettings.topSpanNames")}>
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={[
              t("settings.diagnosticsSettings.span"),
              t("settings.diagnosticsSettings.count"),
              t("settings.diagnosticsSettings.failures"),
              t("settings.diagnosticsSettings.average"),
              t("settings.diagnosticsSettings.max"),
            ]}
            minTableWidth="min-w-[760px]"
            columnWidths={["w-[48%]", "w-[13%]", "w-[13%]", "w-[13%]", "w-[13%]"]}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading
                ? t("settings.diagnosticsSettings.loadingSpanNames")
                : t("settings.diagnosticsSettings.noSpans")
            }
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

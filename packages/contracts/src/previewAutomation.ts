import { t } from "@t3tools/i18n";
import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));
const URL_GUIDANCE =
  "Absolute http(s) URL or a schemeless host such as t3.chat or localhost:5173. Schemeless public hosts use https; loopback hosts use http.";
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(60_000))
    .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." }),
).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." });

/** Operations understood by desktop hosts predating viewport resizing. */
export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

/** Advertised by current desktop hosts for mixed-version routing. */
export const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
] as const;

export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description:
        "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
    }),
  ).annotate({
    description:
      "Exact collaborative browser tab to target. Omit to use this agent session's current tab.",
  }),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  /** Optional for compatibility with desktop hosts predating viewport sizing. */
  viewportSetting: Schema.optional(PreviewViewportSetting),
  /** Measured guest-page viewport in CSS pixels when a webview is ready. */
  viewport: Schema.optional(PreviewRenderedViewportSize),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Optional initial page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether to open the thread-bound inline preview for the human. Defaults to true; set false for background-only automation.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Deprecated alias for open. Whether to reveal the thread-bound inline preview to the human.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Reuse tabId when supplied, otherwise this agent session's current tab. Defaults to true; set false to create a new tab.",
    }),
  ),
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.tabId !== undefined && input.reuseExistingTab === false) ||
        t("previewErrors.previewAutomation.tabIdWithReuseDisabled"),
    ),
  )
  .annotate({
    description:
      "Opens the collaborative browser for the current thread. Use preview_navigate afterward when readiness waiting matters.",
  });
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url").annotate({
      description: "Selects direct URL navigation.",
    }),
    url: BoundedUrl.annotate({
      description: `Direct website URL. ${URL_GUIDANCE}`,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port").annotate({
      description: "Selects a dev-server port relative to the current execution environment.",
    }),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server TCP port inside the current environment." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Dev-server protocol. Defaults to http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Optional path, query, and fragment, for example /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Website URL. ${URL_GUIDANCE} Use this for public pages and directly reachable URLs.`,
  }),
  target: Schema.optional(
    BrowserNavigationTarget.annotate({
      description:
        "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
    }),
  ).annotate({
    description:
      "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
  }),
  readiness: Schema.optional(
    Schema.Literals(["load", "domContentLoaded", "none"]).annotate({
      description:
        "Readiness milestone before returning. 'load' waits for loading to stop (default), 'domContentLoaded' waits for an interactive document, and 'none' returns immediately.",
    }),
  ).annotate({
    description:
      "Readiness milestone before returning. 'load' is the default; use 'none' only when a later wait call will verify the page.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
        t("previewErrors.previewAutomation.provideOneOfUrlOrTarget"),
    ),
  )
  .annotate({
    description:
      "Navigates the active browser tab. Provide exactly one of url or target; for most public pages use url.",
  });
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]).annotate({
    description:
      "Viewport mode: fill follows the preview panel, freeform uses exact independently resizable dimensions, and preset uses a named device size.",
  }),
  preset: Schema.optional(
    PreviewViewportPresetId.annotate({
      description: "Named viewport from Chrome DevTools' standard device catalog.",
    }),
  ).annotate({
    description: "Named device size. Required only when mode is preset.",
  }),
  width: Schema.optional(
    PreviewViewportSize.fields.width.annotate({
      description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
  }),
  height: Schema.optional(
    PreviewViewportSize.fields.height.annotate({
      description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
  }),
  orientation: Schema.optional(
    Schema.Literals(["portrait", "landscape"]).annotate({
      description:
        "Orientation for a fixed device preset. Defaults to the preset's native orientation.",
    }),
  ).annotate({
    description:
      "Orientation for a named device preset. It is not accepted in fill or freeform mode.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const hasPreset = input.preset !== undefined;
      const hasWidth = input.width !== undefined;
      const hasHeight = input.height !== undefined;
      if (hasWidth !== hasHeight) {
        return t("previewErrors.previewAutomation.customDimensionsNeedBoth");
      }
      if (input.mode === "fill") {
        return !hasPreset && !hasWidth && input.orientation === undefined
          ? true
          : t("previewErrors.previewAutomation.fillModeRejectsExtras");
      }
      if (input.mode === "freeform") {
        if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
          return t("previewErrors.previewAutomation.freeformModeRequirements");
        }
      } else if (!hasPreset || hasWidth || hasHeight) {
        return t("previewErrors.previewAutomation.presetModeRequirements");
      }
      if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
        return t("previewErrors.previewAutomation.viewportAreaTooLarge", {
          maxArea: PREVIEW_VIEWPORT_MAX_AREA,
        });
      }
      return true;
    }),
  )
  .annotate({
    description:
      "Sets the active browser tab to fill-panel, independently resizable freeform, or named device-preset sizing.",
  });
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

/** Mirrors DesktopPreviewColorScheme; declared here to keep this module free of ipc.ts imports. */
export const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);
export type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme.annotate({
    description:
      "Emulated prefers-color-scheme for the page: light, dark, or system to follow the OS appearance.",
  }),
}).annotate({
  description:
    "Emulates prefers-color-scheme in the active browser tab without changing the OS or app theme.",
});
export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

const Locator = TrimmedNonEmptyString.annotate({
  description:
    "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
});

const LegacySelector = TrimmedNonEmptyString.annotate({
  description:
    "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
});

export const PreviewAutomationClickInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description:
      "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
  }),
  x: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative X coordinate in CSS pixels. Must be paired with y.",
    }),
  ),
  y: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative Y coordinate in CSS pixels. Must be paired with x.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const selectorModes =
        Number(input.selector !== undefined) + Number(input.locator !== undefined);
      const hasX = input.x !== undefined;
      const hasY = input.y !== undefined;
      if (hasX !== hasY) return t("previewErrors.previewAutomation.coordinatesNeedXAndY");
      const coordinateModes = hasX && hasY ? 1 : 0;
      return (
        selectorModes + coordinateModes === 1 ||
        t("previewErrors.previewAutomation.provideOneClickTarget")
      );
    }),
  )
  .annotate({
    description:
      "Clicks one target. Provide exactly one of locator, selector, or the x/y coordinate pair.",
  });
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for the input. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector for the input, for example role=textbox[name='Message'] or textarea[placeholder*='Message'].",
  }),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the existing input value before inserting text. Defaults to false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        t("previewErrors.previewAutomation.selectorOrLocatorAtMostOne"),
    ),
  )
  .annotate({
    description:
      "Types into locator/selector, or into the currently focused element when neither target is provided.",
  });
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
      }),
    )
    .annotateKey({
      description:
        "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
    }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])).annotate({
      description: "Modifier keys held while pressing key.",
    }),
  ),
}).annotate({ description: "Presses one keyboard key in the active browser tab." });
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(
    Schema.Finite.annotate({
      description: "Horizontal scroll delta in CSS pixels. Positive scrolls right. Defaults to 0.",
    }),
  ),
  deltaY: Schema.optional(
    Schema.Finite.annotate({
      description: "Vertical scroll delta in CSS pixels. Positive scrolls down. Defaults to 0.",
    }),
  ),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for a scrollable container. Omit to scroll the viewport.",
  }),
  locator: Schema.optional(Locator).annotate({
    description: "Playwright selector for a scrollable container. Omit to scroll the viewport.",
  }),
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return t("previewErrors.previewAutomation.selectorOrLocatorAtMostOne");
      }
      return (
        input.deltaX !== undefined ||
        input.deltaY !== undefined ||
        t("previewErrors.previewAutomation.provideDeltaXOrDeltaY")
      );
    }),
  )
  .annotate({
    description:
      "Scrolls the viewport, or a locator/selector container. Provide deltaX, deltaY, or both.",
  });
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
      }),
    )
    .check(Schema.isMaxLength(64_000))
    .annotateKey({
      description:
        "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
    }),
  awaitPromise: Schema.optional(
    Schema.Boolean.annotate({ description: "Await a returned Promise. Defaults to true." }),
  ),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Serialize and return the value instead of a remote object reference. Defaults to true.",
    }),
  ),
}).annotate({
  description:
    "Evaluates JavaScript in the page. Prefer snapshot and semantic actions; use evaluate for inspection or unsupported interactions.",
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector that must match an element. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector that must match an element, for example role=button[name='Send'].",
  }),
  text: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Case-sensitive substring that must appear in visible document text.",
    }),
  ).annotate({
    description: "Case-sensitive substring that must appear in visible document text.",
  }),
  urlIncludes: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Substring that must appear in the current absolute URL.",
    }),
  ).annotate({ description: "Substring that must appear in the current absolute URL." }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return t("previewErrors.previewAutomation.selectorOrLocatorAtMostOne");
      }
      return (
        input.selector !== undefined ||
        input.locator !== undefined ||
        input.text !== undefined ||
        input.urlIncludes !== undefined ||
        t("previewErrors.previewAutomation.provideWaitCondition")
      );
    }),
  )
  .annotate({
    description:
      "Waits until all provided conditions match. Use after click/type when the page changes asynchronously.",
  });
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});
export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PREVIEW_RECORDING_STOP_TIMEOUT_MS = 120_000;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
export type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /**
   * Missing means the pre-capability-negotiation V1 operation set. This lets
   * a newer server safely coexist with an older desktop during rollout.
   */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
  liveTabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        tabId: PreviewTabId,
        visible: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  tabIdExplicit: Schema.optional(Schema.Boolean),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: PreviewAutomationRequest,
  }),
]);
export type PreviewAutomationStreamEvent = typeof PreviewAutomationStreamEvent.Type;

export const PreviewAutomationResponse = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

const McpCapabilityErrorFields = {
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

/** Agents read this message, so it names the next step and not only the failure. */
export class PreviewAutomationUnavailableError extends Schema.TaggedError<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.capabilityPreviewUnavailable", {
      capability: this.capability,
    });
  }
}

/** A `t3-code` MCP tool was called with a credential that does not carry its capability. */
export class McpCapabilityUnavailableError extends Schema.TaggedError<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: TrimmedNonEmptyString,
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.capabilityUnavailable", {
      capability: this.capability,
    });
  }
}

const PreviewAutomationScopeErrorFields = {
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

const PreviewAutomationRequestErrorFields = {
  ...PreviewAutomationScopeErrorFields,
  clientId: TrimmedNonEmptyString,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
};

const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedError<PreviewAutomationNoAvailableHostError>()(
  "PreviewAutomationNoAvailableHostError",
  {
    ...PreviewAutomationScopeErrorFields,
    clientId: Schema.optional(TrimmedNonEmptyString),
    connectionId: Schema.optional(PreviewAutomationConnectionId),
    requestId: Schema.optional(TrimmedNonEmptyString),
    tabId: Schema.optional(PreviewTabId),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.noAvailableHost", {
      operation: this.operation,
      environmentId: this.environmentId,
    });
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedError<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.unsupportedClient", {
      clientId: this.clientId,
      operation: this.operation,
    });
  }
}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedError<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return this.tabId
      ? t("previewErrors.previewAutomation.tabNotFoundExplicit", {
          tabId: this.tabId,
          operation: this.operation,
        })
      : t("previewErrors.previewAutomation.tabNotFoundWithoutTabId", {
          operation: this.operation,
        });
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = t("previewErrors.previewAutomation.timedOut", {
      operation: this.operation,
      timeoutMs: this.timeoutMs,
    });
    return summary;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedError<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.interruptedOnClient", {
      operation: this.operation,
      clientId: this.clientId,
    });
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedError<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.failedOnClient", {
      operation: this.operation,
      clientId: this.clientId,
    });
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedError<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return t("previewErrors.previewAutomation.invalidSelectorWithKind", {
        operation: this.operation,
        selectorKind: this.selectorKind,
        selectorLength: this.selectorLength,
      });
    }
    return t("previewErrors.previewAutomation.invalidSelector", {
      operation: this.operation,
    });
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedError<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind === "focused-element") {
      return t("previewErrors.previewAutomation.requiresEditableFocusedElement", {
        operation: this.operation,
      });
    }
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return t("previewErrors.previewAutomation.requiresEditableTargetWithKind", {
        operation: this.operation,
        selectorKind: this.selectorKind,
        selectorLength: this.selectorLength,
      });
    }
    return t("previewErrors.previewAutomation.requiresEditableTarget", {
      operation: this.operation,
    });
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedError<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    maximumBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  },
) {
  override get message(): string {
    const summary =
      this.maximumBytes === undefined
        ? t("previewErrors.previewAutomation.resultTooLarge", { operation: this.operation })
        : t("previewErrors.previewAutomation.resultLargerThanMaximum", {
            operation: this.operation,
            maximumBytes: this.maximumBytes,
          });
    return summary;
  }
}

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedError<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.clientDisconnected", {
      clientId: this.clientId,
      operation: this.operation,
    });
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedError<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.clientStoppedAcceptingRequests", {
      clientId: this.clientId,
      operation: this.operation,
    });
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedError<PreviewAutomationRemoteUnavailableError>()(
  "PreviewAutomationRemoteUnavailableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.unavailableOnClient", {
      operation: this.operation,
      clientId: this.clientId,
    });
  }
}

export class PreviewAutomationMalformedResponseError extends Schema.TaggedError<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.malformedResponse", {
      clientId: this.clientId,
      operation: this.operation,
    });
  }
}

export class PreviewAutomationRecordingTransferError extends Schema.TaggedError<PreviewAutomationRecordingTransferError>()(
  "PreviewAutomationRecordingTransferError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.recordingSaveFailed");
  }
}

export class PreviewAutomationRecordingDesktopUpdateRequiredError extends Schema.TaggedError<PreviewAutomationRecordingDesktopUpdateRequiredError>()(
  "PreviewAutomationRecordingDesktopUpdateRequiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.recordingNeedsDesktopUpdate");
  }
}

export class PreviewAutomationRecordingTooLargeError extends Schema.TaggedError<PreviewAutomationRecordingTooLargeError>()(
  "PreviewAutomationRecordingTooLargeError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.recordingTooLarge");
  }
}

export class PreviewAutomationRecordingDeadlineExpiredError extends Schema.TaggedError<PreviewAutomationRecordingDeadlineExpiredError>()(
  "PreviewAutomationRecordingDeadlineExpiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return t("previewErrors.previewAutomation.recordingTransferExpired");
  }
}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationUnavailableError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationMalformedResponseError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export const PreviewUrlResolution = Schema.Struct({
  requestedUrl: Schema.String,
  resolvedUrl: Schema.String,
  resolutionKind: Schema.Literals(["direct", "direct-private-network"]),
  environmentId: EnvironmentId,
});
export type PreviewUrlResolution = typeof PreviewUrlResolution.Type;

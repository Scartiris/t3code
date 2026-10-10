import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { mergeProviderSnapshot } from "./Layers/ProviderRegistry.ts";
import { withCcSwitchModels } from "./CcSwitchModels.ts";

const original = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [
    {
      slug: "native-default",
      name: "Native",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

describe("CC Switch model inventories", () => {
  it("replaces a previous native or site catalog, including during startup and failed probes", () => {
    const stamp = withCcSwitchModels(
      [
        {
          name: "T3CODE_CC_SWITCH_MODELS",
          value: JSON.stringify({ selected: "site-model", models: ["site-model", "other-model"] }),
          sensitive: false,
        },
      ],
      (value: ServerProvider) => value,
    );
    for (const status of ["ready", "warning", "error"] as const) {
      const snapshot = stamp({ ...original, status, installed: status === "ready" });
      const merged = mergeProviderSnapshot(original, snapshot);
      assert.deepEqual(
        merged.models.map((model) => model.slug),
        ["site-model", "other-model"],
      );
      assert.deepEqual(
        merged.models.filter((model) => model.isDefault).map((model) => model.slug),
        ["site-model"],
      );
      const refreshed = withCcSwitchModels(
        [
          {
            name: "T3CODE_CC_SWITCH_MODELS",
            value: JSON.stringify({ selected: "other-model", models: ["other-model"] }),
            sensitive: false,
          },
        ],
        (value: ServerProvider) => value,
      )(original);
      assert.deepEqual(
        mergeProviderSnapshot(merged, refreshed).models.map((model) => model.slug),
        ["other-model"],
      );
    }
  });
});

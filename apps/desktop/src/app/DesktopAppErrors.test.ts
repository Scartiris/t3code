import { assert, describe, it } from "@effect/vitest";
import { t } from "@t3tools/shared/i18n";

import {
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
} from "./DesktopApp.ts";

describe("DesktopApp errors", () => {
  it("preserves unavailable backend port context", () => {
    const error = new DesktopBackendPortUnavailableError({
      startPort: 3_773,
      maxPort: 65_535,
      hosts: ["127.0.0.1", "0.0.0.0", "::"],
    });

    assert.equal(error.startPort, 3_773);
    assert.equal(error.maxPort, 65_535);
    assert.deepEqual(error.hosts, ["127.0.0.1", "0.0.0.0", "::"]);
    assert.equal(
      error.message,
      t("app.desktopApp.noBackendPortAvailable", {
        hosts: "127.0.0.1, 0.0.0.0, ::",
        startPort: 3_773,
        maxPort: 65_535,
      }),
    );
  });

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, t("app.desktopApp.developmentPortRequired"));
  });
});

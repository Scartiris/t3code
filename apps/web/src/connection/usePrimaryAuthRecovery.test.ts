import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { shouldProbeServerAuth } from "./usePrimaryAuthRecovery";

const BASE_STATE: SupervisorConnectionState = {
  desired: true,
  network: "online",
  phase: "backoff",
  stage: null,
  attempt: 4,
  generation: 1,
  lastFailure: new ConnectionTransientError({
    reason: "transport",
    detail: "the browser could not establish a WebSocket connection.",
  }),
  retryAt: null,
};

const NOW = 1_000_000;

function decide(
  connectionState: SupervisorConnectionState | null,
  overrides: { pathname?: string; lastRecoveryAtMs?: number } = {},
) {
  return shouldProbeServerAuth({
    connectionState,
    pathname: overrides.pathname ?? "/",
    nowMs: NOW,
    lastRecoveryAtMs: overrides.lastRecoveryAtMs ?? 0,
  });
}

describe("shouldProbeServerAuth", () => {
  it("probes once a transport failure has repeated past the first retries", () => {
    expect(decide(BASE_STATE)).toBe(true);
  });

  it("waits out the first retries so a blip does not trigger a probe", () => {
    expect(decide({ ...BASE_STATE, attempt: 1 })).toBe(false);
    expect(decide({ ...BASE_STATE, attempt: 2 })).toBe(false);
    expect(decide({ ...BASE_STATE, attempt: 3 })).toBe(true);
  });

  it("ignores a connection state that has not loaded yet", () => {
    expect(decide(null)).toBe(false);
  });

  it("ignores a healthy or merely connecting environment", () => {
    expect(decide({ ...BASE_STATE, phase: "connected", lastFailure: null })).toBe(false);
    expect(decide({ ...BASE_STATE, phase: "connecting" })).toBe(false);
    expect(decide({ ...BASE_STATE, phase: "available", lastFailure: null })).toBe(false);
  });

  it("probes while offline too, which is the phase a capped backoff lands in", () => {
    expect(decide({ ...BASE_STATE, phase: "offline" })).toBe(true);
  });

  it("leaves a non-transport failure alone, since the gate would not explain it", () => {
    // A blocked phase means the client already identified the cause; reloading
    // would discard a message the user needs to read.
    expect(
      decide({
        ...BASE_STATE,
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({ reason: "authentication", detail: "no session" }),
      }),
    ).toBe(false);
  });

  it("leaves a transport failure with a different reason alone", () => {
    expect(
      decide({
        ...BASE_STATE,
        lastFailure: new ConnectionTransientError({ reason: "network", detail: "offline" }),
      }),
    ).toBe(false);
  });

  it("does not probe again inside the cooldown, so a defect cannot reload in a loop", () => {
    expect(decide(BASE_STATE, { lastRecoveryAtMs: NOW - 89_999 })).toBe(false);
    expect(decide(BASE_STATE, { lastRecoveryAtMs: NOW - 90_000 })).toBe(true);
  });

  it("does not probe from the pairing surface it would redirect to", () => {
    expect(decide(BASE_STATE, { pathname: "/pair" })).toBe(false);
  });
});

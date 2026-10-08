import type { AuthSessionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installEnvironmentHttpTest } from "../../../test/environmentHttpTest";
import {
  __resetServerAuthBootstrapForTests,
  invalidateServerAuthGate,
  resolveInitialServerAuthGateState,
} from "./auth";

/**
 * The other half of `connection/usePrimaryAuthRecovery.ts`.
 *
 * That hook notices a connection that keeps failing for transport reasons and
 * asks the HTTP API whether we are still authenticated. What it does with the
 * answer -- drop the gate's memo so the root route re-runs it -- is what these
 * cases pin down, because the failure it exists to repair is one the browser
 * cannot report: a rejected WebSocket upgrade exposes no status and no body, so
 * a lost session looks exactly like a dropped connection.
 */

const AUTH_DESCRIPTOR = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session_3773_test",
} satisfies AuthSessionState["auth"];

const AUTHENTICATED = { authenticated: true, auth: AUTH_DESCRIPTOR } satisfies AuthSessionState;
const UNAUTHENTICATED = { authenticated: false, auth: AUTH_DESCRIPTOR } satisfies AuthSessionState;

let sessionState: AuthSessionState = AUTHENTICATED;
let sessionProbeCount = 0;
let disposeHttpTest: (() => Promise<void>) | undefined;

function installTestBrowser(url = "https://t3.test/") {
  // No desktopBridge: a browser loaded from the remote origin has no local
  // bootstrap credential, which is precisely the case where the session cookie
  // is the only thing that can authenticate the socket.
  vi.stubGlobal("window", {
    location: new URL(url),
    history: { replaceState: vi.fn() },
    desktopBridge: undefined,
  });
}

describe("server auth gate recovery", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    installTestBrowser();
    sessionState = AUTHENTICATED;
    sessionProbeCount = 0;
    const testApi = await installEnvironmentHttpTest({
      session: () => {
        sessionProbeCount += 1;
        return Effect.succeed(sessionState);
      },
    });
    disposeHttpTest = testApi.dispose;
  });

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
  });

  it("memoizes an authenticated verdict, so a session lost later stays invisible", async () => {
    expect((await resolveInitialServerAuthGateState()).status).toBe("authenticated");

    // The cookie jar is cleared, or the session expires. Exactly what the live
    // host showed for 21 hours while a client retried the socket forever.
    sessionState = UNAUTHENTICATED;

    expect((await resolveInitialServerAuthGateState()).status).toBe("authenticated");
    expect(sessionProbeCount).toBe(1);
  });

  it("re-probes and routes to pairing once the memo is invalidated", async () => {
    expect((await resolveInitialServerAuthGateState()).status).toBe("authenticated");
    const probesBeforeInvalidation = sessionProbeCount;

    sessionState = UNAUTHENTICATED;
    invalidateServerAuthGate();

    const recovered = await resolveInitialServerAuthGateState();
    expect(recovered.status).toBe("requires-auth");
    expect(sessionProbeCount).toBeGreaterThan(probesBeforeInvalidation);
    // The pairing surface renders `auth` from this state, so it has to carry the
    // descriptor rather than being an empty placeholder.
    expect(recovered.status === "requires-auth" && recovered.auth.sessionCookieName).toBe(
      "t3_session_3773_test",
    );
  });

  it("does not send a healthy client through pairing when it is invalidated wrongly", async () => {
    expect((await resolveInitialServerAuthGateState()).status).toBe("authenticated");

    invalidateServerAuthGate();

    // Re-probing is enough: if the session is still good, the user sees nothing.
    expect((await resolveInitialServerAuthGateState()).status).toBe("authenticated");
    expect(sessionProbeCount).toBeGreaterThan(1);
  });
});

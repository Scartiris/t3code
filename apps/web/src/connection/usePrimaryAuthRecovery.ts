import { useAtomValue } from "@effect/atom-react";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { fetchSessionState, invalidateServerAuthGate } from "../environments/primary/auth";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentCatalog } from "./catalog";

/**
 * The connect path cannot tell an authentication failure from a dropped socket.
 * A browser WebSocket exposes neither the HTTP status nor the body of a rejected
 * upgrade, so a 401 arrives as an ordinary connection error, the supervisor
 * files it under `transport` and retries it on the capped backoff schedule
 * indefinitely. Meanwhile `resolveInitialServerAuthGateState` replays its
 * memoized "authenticated" verdict from page load, so the pairing surface that
 * would fix it is never reached.
 *
 * The HTTP API can answer the question the socket cannot. Once the primary
 * environment has failed enough times to rule out a blip, ask it directly: a
 * server that is merely unreachable makes the probe throw, while a server that
 * is up and no longer recognizes us answers `authenticated: false`. Only the
 * second case acts, and reloading is what clears the memo in practice — the
 * root route re-runs the gate on the way back up and routes to pairing.
 */

/** At the backoff schedule, three failures is roughly fifteen seconds of trying. */
const MIN_ATTEMPTS_BEFORE_PROBE = 3;
/** Recovers from a real loss without letting a defect reload the page in a loop. */
const MIN_MS_BETWEEN_RECOVERIES = 90_000;

let lastRecoveryAtMs = 0;

/**
 * Whether a connection state justifies spending a request to ask the server
 * whether we are still authenticated. Kept separate from the effect so the
 * guard conditions can be pinned down without a browser.
 */
export function shouldProbeServerAuth(input: {
  readonly connectionState: SupervisorConnectionState | null;
  readonly pathname: string;
  readonly nowMs: number;
  readonly lastRecoveryAtMs: number;
}): boolean {
  const { connectionState } = input;
  if (connectionState === null) {
    return false;
  }
  if (connectionState.phase !== "backoff" && connectionState.phase !== "offline") {
    return false;
  }
  if (connectionState.attempt < MIN_ATTEMPTS_BEFORE_PROBE) {
    return false;
  }
  // `blocked` is the phase where the client already knows this is auth, and a
  // non-transport failure is some other problem the gate would not explain.
  if (connectionState.lastFailure?._tag !== "ConnectionTransientError") {
    return false;
  }
  if (connectionState.lastFailure.reason !== "transport") {
    return false;
  }
  if (input.nowMs - input.lastRecoveryAtMs < MIN_MS_BETWEEN_RECOVERIES) {
    return false;
  }
  // Already on the surface this would land on.
  return input.pathname !== "/pair";
}

const primaryConnectionStateAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))));
}).pipe(Atom.withLabel("web-primary-connection-state"));

/** @public Mounted once by the root route. */
export function usePrimaryAuthRecovery(): void {
  const connectionState = useAtomValue(primaryConnectionStateAtom);
  const probing = useRef(false);

  useEffect(() => {
    if (
      probing.current ||
      !shouldProbeServerAuth({
        connectionState,
        pathname: window.location.pathname,
        nowMs: Date.now(),
        lastRecoveryAtMs,
      })
    ) {
      return;
    }

    let cancelled = false;
    probing.current = true;
    void (async () => {
      try {
        const session = await fetchSessionState();
        if (cancelled || session.authenticated) {
          return;
        }
        lastRecoveryAtMs = Date.now();
        invalidateServerAuthGate();
        window.location.reload();
      } catch {
        // Unreachable server, or the probe itself failed. That is the transport
        // problem the supervisor is already retrying; leave it alone.
      } finally {
        probing.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionState]);
}

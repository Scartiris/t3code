// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or free-space query.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { t } from "@t3tools/shared/i18n";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeStream from "node:stream";
import * as Yauzl from "yauzl";

import * as ServerConfig from "../config.ts";
import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const DOWNLOAD_TIMEOUT = "45 minutes";
const VALIDATION_TIMEOUT = "90 seconds";
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";

const ReleaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ActiveRelease = Schema.Struct({ releaseId: ReleaseId });
const InstalledRelease = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
  harness: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
});
type InstalledRelease = typeof InstalledRelease.Type;
const encodeActiveRelease = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
const encodeInstalledRelease = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));

export class AntigravityInstallationError extends Schema.TaggedError<AntigravityInstallationError>()(
  "AntigravityInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(AntigravityInstallationError);

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly harnessPath: string;
  readonly source: "override" | "managed" | "path";
  readonly version: string | null;
  readonly managedVersionDirectory: string | null;
}

interface AntigravityInstallationService {
  readonly managedDirectory: string;
  readonly resolve: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
  /** Hold the lease until the spawned process has exited. */
  readonly acquire: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
  readonly start: Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, AntigravityInstallationError>;
}

export class AntigravityInstallation extends Context.Service<
  AntigravityInstallation,
  AntigravityInstallationService
>()("t3/provider/AntigravityInstallation") {
  static readonly layer = Layer.effect(
    AntigravityInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeAntigravityInstallation({ baseDir: config.baseDir });
    }),
  );
}

export interface AntigravityInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: AntigravityReleaseAsset | null;
  readonly validate?: (
    executable: AntigravityExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, AntigravityInstallationError, Scope.Scope>;
}

const installationError = (operation: string, detail: string, cause?: unknown) =>
  new AntigravityInstallationError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);

function executableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

function isRunning(state: ProviderInstallState) {
  return (
    state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
  );
}

/** Open only a verified local archive. Entries stay lazy and extraction stays bounded. */
const openArchive = Effect.fn("AntigravityInstallation.openArchive")(function* (
  archivePath: string,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly zip: Yauzl.ZipFile;
        readonly error: () => AntigravityInstallationError | undefined;
        readonly close: Effect.Effect<void>;
      },
      AntigravityInstallationError
    >((resume) => {
      Yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error || !zip) {
            resume(
              Effect.fail(
                installationError(
                  "extract",
                  t("provider.antigravityInstallation.openVerifiedArchiveFailed"),
                  error,
                ),
              ),
            );
            return;
          }
          let closed = false;
          let archiveError: AntigravityInstallationError | undefined;
          zip.on("close", () => {
            closed = true;
          });
          zip.on("error", (cause: unknown) => {
            archiveError = installationError(
              "extract",
              t("provider.antigravityInstallation.archiveUnreadable"),
              cause,
            );
          });
          resume(
            Effect.succeed({
              zip,
              error: () => archiveError,
              close: Effect.callback<void>((finish) => {
                if (closed) {
                  finish(Effect.void);
                  return;
                }
                const onClose = () => {
                  zip.removeListener("error", onError);
                  finish(Effect.void);
                };
                const onError = (cause: unknown) => {
                  zip.removeListener("close", onClose);
                  finish(
                    Effect.die(
                      installationError(
                        "extract",
                        t("provider.antigravityInstallation.closeArchiveFailed"),
                        cause,
                      ),
                    ),
                  );
                };
                zip.once("close", onClose);
                zip.once("error", onError);
                zip.close();
              }),
            }),
          );
        },
      );
    }),
    (opened) => opened.close,
  );

  const next = Effect.callback<Yauzl.Entry | null, AntigravityInstallationError>((resume) => {
    const existingError = opened.error();
    if (existingError) {
      resume(Effect.fail(existingError));
      return;
    }
    const cleanup = () => {
      opened.zip.removeListener("entry", onEntry);
      opened.zip.removeListener("end", onEnd);
      opened.zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(
        Effect.fail(
          installationError(
            "extract",
            t("provider.antigravityInstallation.archiveUnreadable"),
            cause,
          ),
        ),
      );
    };
    opened.zip.once("entry", onEntry);
    opened.zip.once("end", onEnd);
    opened.zip.once("error", onError);
    opened.zip.readEntry();
    return Effect.sync(cleanup);
  });

  const streamEntry = (entry: Yauzl.Entry) =>
    Effect.acquireRelease(
      Effect.callback<NodeStream.Readable, AntigravityInstallationError>((resume) => {
        opened.zip.openReadStream(entry, (cause, readable) => {
          resume(
            cause || !readable
              ? Effect.fail(
                  installationError(
                    "extract",
                    t("provider.antigravityInstallation.archiveMemberReadFailed"),
                    cause,
                  ),
                )
              : Effect.succeed(readable),
          );
        });
      }),
      (readable) =>
        Effect.sync(() => {
          readable.destroy();
        }),
    );
  return { entryCount: opened.zip.entryCount, next, streamEntry };
});

export const makeAntigravityInstallation = Effect.fn("AntigravityInstallation.make")(function* (
  options: AntigravityInstallationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const releaseAsset =
    options.releaseAsset === undefined
      ? resolveAntigravityReleaseAsset(platform, arch)
      : options.releaseAsset;
  const names = executableNames(platform);
  const managedDirectory = path.join(
    options.baseDir,
    "tools",
    "antigravity-acp",
    `${platform}-${arch}`,
  );
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  const gate = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: releaseAsset?.archiveBytes ?? null,
    version: releaseAsset?.version ?? null,
    installedVersion: null,
    canRemove: false,
    message: null,
  });

  const readRecord = Effect.fn("AntigravityInstallation.readRecord")(function* <A>(
    filePath: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || Number(info.size) > RECORD_MAX_BYTES) {
      return yield* installationError(
        "resolve",
        t("provider.antigravityInstallation.managedRecordInvalid"),
      );
    }
    const contents = yield* fs.readFileString(filePath);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents);
  });

  const executableFile = Effect.fn("AntigravityInstallation.executableFile")(function* (
    filePath: string,
    bytes?: number,
  ) {
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    return (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (bytes === undefined || Number(info.value.size) === bytes) &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    );
  });

  const completedRelease = Effect.fn("AntigravityInstallation.completedRelease")(function* (
    releaseId: string,
  ) {
    const directory = path.join(versionsDirectory, releaseId);
    const record = yield* readRecord(path.join(directory, RELEASE_RECORD), InstalledRelease);
    if (
      record.releaseId !== releaseId ||
      record.executable.name !== names.executable ||
      record.harness.name !== names.harness ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      !Number.isSafeInteger(record.harness.bytes) ||
      record.harness.bytes <= 0 ||
      !record.version.trim() ||
      !(yield* executableFile(path.join(directory, names.executable), record.executable.bytes)) ||
      !(yield* executableFile(path.join(directory, names.harness), record.harness.bytes))
    ) {
      return yield* installationError(
        "resolve",
        t("provider.antigravityInstallation.managedRuntimeIncomplete"),
      );
    }
    return {
      executablePath: path.join(directory, names.executable),
      harnessPath: path.join(directory, names.harness),
      source: "managed",
      version: record.version,
      managedVersionDirectory: directory,
    } satisfies AntigravityExecutable;
  });

  const fromExternal = Effect.fn("AntigravityInstallation.fromExternal")(function* (
    candidate: string,
    source: "override" | "path",
  ) {
    if (!(yield* executableFile(candidate))) return null;
    const executablePath = yield* fs.realPath(candidate);
    const directory = path.dirname(executablePath);
    const harnessPath = path.join(directory, names.harness);
    if (!(yield* executableFile(harnessPath))) return null;
    const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
    if (
      Option.isSome(realVersions) &&
      path.dirname(directory) === realVersions.value &&
      /^[a-f0-9]{64}$/u.test(path.basename(directory))
    ) {
      const installed = yield* completedRelease(path.basename(directory));
      return { ...installed, executablePath, harnessPath, source } satisfies AntigravityExecutable;
    }
    return {
      executablePath,
      harnessPath,
      source,
      version: null,
      managedVersionDirectory: null,
    } satisfies AntigravityExecutable;
  });

  const pathCandidates = (binary: string, processEnvironment = environment) => {
    const pathValue =
      platform === "win32"
        ? Object.entries(processEnvironment).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
        : processEnvironment.PATH;
    return (pathValue ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
      .filter((directory) => directory.length > 0)
      .map((directory) => path.resolve(directory, binary));
  };

  const resolve: AntigravityInstallationService["resolve"] = Effect.fn(
    "AntigravityInstallation.resolve",
  )(
    function* (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) {
      const override = binaryPath?.trim();
      if (override) {
        const candidates =
          path.isAbsolute(override) || override.includes("/") || override.includes("\\")
            ? [path.resolve(override)]
            : pathCandidates(override, processEnvironment);
        for (const candidate of candidates) {
          const selected = yield* fromExternal(candidate, "override");
          if (selected) return selected;
        }
        return yield* installationError(
          "resolve",
          t("provider.antigravityInstallation.customExecutableUnusable"),
        );
      }
      if (yield* fs.exists(activePath)) {
        const active = yield* readRecord(activePath, ActiveRelease);
        return yield* completedRelease(active.releaseId);
      }
      for (const candidate of pathCandidates(names.executable, processEnvironment)) {
        const selected = yield* fromExternal(candidate, "path");
        if (selected) return selected;
      }
      return yield* installationError(
        "resolve",
        releaseAsset
          ? t("provider.antigravityInstallation.notInstalled")
          : t("provider.antigravityInstallation.platformUnsupported", { platform, arch }),
      );
    },
    Effect.mapError(
      wrapFailure("resolve", t("provider.antigravityInstallation.readInstallationFailed")),
    ),
  );

  const acquire = (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) =>
    Effect.acquireRelease(
      gate.withPermit(
        Effect.gen(function* () {
          const executable = yield* resolve(binaryPath, processEnvironment);
          const directory = executable.managedVersionDirectory;
          if (directory) leases.set(directory, (leases.get(directory) ?? 0) + 1);
          return executable;
        }),
      ),
      (executable) =>
        gate.withPermit(
          Effect.sync(() => {
            const directory = executable.managedVersionDirectory;
            if (!directory) return;
            const remaining = (leases.get(directory) ?? 1) - 1;
            if (remaining > 0) leases.set(directory, remaining);
            else leases.delete(directory);
          }),
        ),
    );

  const validate =
    options.validate ??
    Effect.fn("AntigravityInstallation.validate")(
      function* (executable: AntigravityExecutable, expectedVersion: string) {
        const profileDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-antigravity-validate-",
        });
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          platform,
          baseEnv: environment,
          // The profile is scoped, so it cleans up the unpack; a shallow
          // root keeps it under Windows' path limit.
          tempDirectory: profileDirectory,
        });
        const runtime = yield* makeAntigravityAcpRuntime({
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: profileDirectory,
            baseEnv: environment,
          }),
          cwd: profileDirectory,
          childProcessSpawner: spawner,
          clientInfo: { name: "t3-code", version: "0.0.0" },
        });
        const initialized = yield* runtime.initialize();
        if (
          initialized.agentInfo?.name !== "antigravity-acp" ||
          initialized.agentInfo.version !== expectedVersion ||
          // Antigravity 1.1.1 can report 2 with the legacy ACP response shape.
          // The ACP client chooses the session wire format from that shape.
          (initialized.protocolVersion !== 1 && initialized.protocolVersion !== 2) ||
          initialized.agentCapabilities?.loadSession !== true ||
          !initialized.agentCapabilities.sessionCapabilities?.resume ||
          !initialized.agentCapabilities.auth?.logout ||
          !initialized.authMethods?.some((method) => method.id === "oauth-personal")
        ) {
          return yield* installationError(
            "verify",
            t("provider.antigravityInstallation.downloadedRuntimeMismatch"),
          );
        }
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        wrapFailure("verify", t("provider.antigravityInstallation.downloadedRuntimeStartFailed")),
      ),
    );

  const install = Effect.fn("AntigravityInstallation.install")(
    function* (asset: AntigravityReleaseAsset) {
      yield* resolveNodeExecutable("Antigravity", environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcessPlatform, platform),
        Effect.mapError((cause) =>
          installationError("verify", nodeRuntimeUnavailableMessage("Antigravity"), cause),
        ),
      );
      const report = (phase: ProviderInstallState["phase"], message: string | null) =>
        SubscriptionRef.update(state, (current) => ({ ...current, phase, message }));
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(versionsDirectory, asset.sha256);
      const activate = Effect.fn("AntigravityInstallation.activate")(
        function* () {
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          const pointerPath = path.join(pointerDirectory, "contents.tmp");
          yield* fs.writeFileString(
            pointerPath,
            yield* encodeActiveRelease({ releaseId: asset.sha256 }),
            { flag: "wx", mode: 0o600 },
          );
          yield* fs.rename(pointerPath, activePath);
          // The pointer commits the install. Later temp cleanup cannot undo it.
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                phase: "succeeded",
                installedVersion: asset.version,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.mapError(
          wrapFailure("activate", t("provider.antigravityInstallation.activateFailed")),
        ),
        Effect.uninterruptible,
      );

      if (yield* fs.exists(destination)) {
        const existing = yield* completedRelease(asset.sha256);
        if (existing.version !== asset.version) {
          return yield* installationError(
            "verify",
            t("provider.antigravityInstallation.existingReleaseVersionMismatch"),
          );
        }
        yield* report("verifying", t("provider.antigravityInstallation.checkingInstalledRuntime"));
        yield* validate(existing, asset.version).pipe(
          Effect.scoped,
          Effect.timeout(VALIDATION_TIMEOUT),
        );
        yield* activate();
        return;
      }

      const available = yield* Effect.tryPromise(() =>
        NodeFSP.statfs(versionsDirectory, { bigint: true }),
      ).pipe(Effect.option);
      const required =
        asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN;
      if (
        Option.isSome(available) &&
        available.value.bavail * available.value.bsize < BigInt(required)
      ) {
        return yield* installationError(
          "download",
          t("provider.antigravityInstallation.insufficientFreeSpace", {
            size: Math.ceil(required / 1024 / 1024),
          }),
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: versionsDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.zip");
      const pairDirectory = path.join(staging, "runtime");
      yield* fs.makeDirectory(pairDirectory);
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        const response = yield* http
          .execute(HttpClientRequest.get(asset.url))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        // dl.google.com gzips the zip when the client accepts it, so
        // `content-length` is the encoded size. The decoded stream is still
        // checked against the pinned byte count and hash below.
        const contentLength = response.headers["content-length"];
        const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
        const identityBody = contentEncoding === undefined || contentEncoding === "identity";
        if (
          identityBody &&
          contentLength !== undefined &&
          Number(contentLength) !== asset.archiveBytes
        ) {
          return yield* installationError(
            "download",
            t("provider.antigravityInstallation.downloadSizeMismatch"),
          );
        }
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              downloadedBytes += chunk.byteLength;
              if (downloadedBytes > asset.archiveBytes) {
                return yield* installationError(
                  "download",
                  t("provider.antigravityInstallation.downloadSizeExceeded"),
                );
              }
              hash.update(chunk);
              const now = yield* Clock.currentTimeMillis;
              if (now - lastProgressAt >= 250 || downloadedBytes === asset.archiveBytes) {
                lastProgressAt = now;
                yield* SubscriptionRef.update(state, (current) => ({
                  ...current,
                  downloadedBytes,
                }));
              }
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        );
      }).pipe(Effect.timeout(DOWNLOAD_TIMEOUT));
      if (downloadedBytes !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
        return yield* installationError(
          "download",
          t("provider.antigravityInstallation.downloadChecksumFailed"),
        );
      }

      yield* report("extracting", t("provider.antigravityInstallation.extracting"));
      yield* Effect.gen(function* () {
        const archive = yield* openArchive(archivePath);
        if (archive.entryCount !== 2) {
          return yield* installationError(
            "extract",
            t("provider.antigravityInstallation.archiveMemberSetInvalid"),
          );
        }
        const seen = new Set<string>();
        for (;;) {
          const entry = yield* archive.next;
          if (!entry) break;
          const expected = [asset.executable, asset.harness].find(
            (file) => file.name === entry.fileName,
          );
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            !expected ||
            seen.has(entry.fileName) ||
            entry.fileName.includes("/") ||
            entry.fileName.includes("\\") ||
            (unixType !== 0 && unixType !== 0o100000) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            entry.uncompressedSize !== expected.bytes
          ) {
            return yield* installationError(
              "extract",
              t("provider.antigravityInstallation.archiveUnsafeMember"),
            );
          }
          seen.add(entry.fileName);
          yield* Effect.gen(function* () {
            const readable = yield* archive.streamEntry(entry);
            let extractedBytes = 0;
            yield* EffectNodeStream.fromReadable<Uint8Array, AntigravityInstallationError>({
              evaluate: () => readable,
              onError: wrapFailure("extract", t("provider.antigravityInstallation.extractFailed")),
            }).pipe(
              Stream.tap((chunk) =>
                Effect.gen(function* () {
                  extractedBytes += chunk.byteLength;
                  if (extractedBytes > expected.bytes) {
                    return yield* installationError(
                      "extract",
                      t("provider.antigravityInstallation.archiveMemberTooLarge"),
                    );
                  }
                }),
              ),
              Stream.run(
                fs.sink(path.join(pairDirectory, entry.fileName), { flag: "wx", mode: 0o700 }),
              ),
            );
            if (extractedBytes !== expected.bytes) {
              return yield* installationError(
                "extract",
                t("provider.antigravityInstallation.archiveMemberTruncated"),
              );
            }
          }).pipe(Effect.scoped);
        }
        if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) {
          return yield* installationError(
            "extract",
            t("provider.antigravityInstallation.archiveMissingFiles"),
          );
        }
      }).pipe(Effect.scoped);
      yield* fs.remove(archivePath);
      if (platform !== "win32") {
        yield* fs.chmod(path.join(pairDirectory, asset.executable.name), 0o755);
        yield* fs.chmod(path.join(pairDirectory, asset.harness.name), 0o755);
      }
      yield* report("verifying", t("provider.antigravityInstallation.checkingDownloadedRuntime"));
      yield* validate(
        {
          executablePath: path.join(pairDirectory, asset.executable.name),
          harnessPath: path.join(pairDirectory, asset.harness.name),
          source: "managed",
          version: asset.version,
          managedVersionDirectory: pairDirectory,
        },
        asset.version,
      ).pipe(Effect.scoped, Effect.timeout(VALIDATION_TIMEOUT));
      const record: InstalledRelease = {
        releaseId: asset.sha256,
        version: asset.version,
        executable: asset.executable,
        harness: asset.harness,
      };
      yield* fs.writeFileString(
        path.join(pairDirectory, RELEASE_RECORD),
        yield* encodeInstalledRelease(record),
        { flag: "wx", mode: 0o600 },
      );
      yield* fs.rename(pairDirectory, destination).pipe(
        Effect.catch((cause) =>
          completedRelease(asset.sha256).pipe(
            Effect.flatMap((existing) =>
              existing.version === asset.version
                ? validate(existing, asset.version).pipe(
                    Effect.scoped,
                    Effect.timeout(VALIDATION_TIMEOUT),
                  )
                : Effect.fail(
                    installationError(
                      "activate",
                      t("provider.antigravityInstallation.anotherInstallPublished"),
                    ),
                  ),
            ),
            Effect.mapError(() =>
              installationError(
                "activate",
                t("provider.antigravityInstallation.publishRuntimeFailed"),
                cause,
              ),
            ),
          ),
        ),
      );
      yield* activate();
    },
    Effect.scoped,
    Effect.mapError(wrapFailure("install", t("provider.antigravityInstallation.installFailed"))),
  );

  const start = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        if (!releaseAsset) {
          return yield* installationError(
            "start",
            t("provider.antigravityInstallation.platformUnsupportedRemote", { platform, arch }),
          );
        }
        const operationId = yield* crypto.randomUUIDv4;
        const next: ProviderInstallState = {
          driver: DRIVER,
          operationId,
          phase: "downloading",
          downloadedBytes: 0,
          totalBytes: releaseAsset.archiveBytes,
          version: releaseAsset.version,
          installedVersion: current.installedVersion,
          canRemove: current.canRemove,
          message: t("provider.antigravityInstallation.downloading"),
        };
        yield* SubscriptionRef.set(state, next);
        const work = install(releaseAsset).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? SubscriptionRef.update(state, (value) => {
                  if (value.operationId !== operationId || value.phase === "succeeded")
                    return value;
                  const error = Cause.findErrorOption(exit.cause);
                  const cancelled = Cause.hasInterruptsOnly(exit.cause);
                  return {
                    ...value,
                    phase: cancelled ? "cancelled" : "failed",
                    message: cancelled
                      ? t("provider.antigravityInstallation.installCancelled")
                      : Option.isSome(error)
                        ? error.value.detail
                        : t("provider.antigravityInstallation.installIncomplete"),
                  } satisfies ProviderInstallState;
                })
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.ensuring(
            Effect.sync(() => {
              if (running?.operationId === operationId) running = undefined;
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
        running = { operationId, fiber };
        return next;
      }).pipe(Effect.uninterruptible),
    )
    .pipe(Effect.mapError(wrapFailure("start", t("provider.antigravityInstallation.startFailed"))));

  const cancel = Effect.fn("AntigravityInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId) {
          return yield* installationError(
            "cancel",
            t("provider.antigravityInstallation.installationNotCurrent"),
          );
        }
        if (running?.operationId === operationId && isRunning(current)) {
          yield* Fiber.interrupt(running.fiber);
        }
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("AntigravityInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases.size > 0) {
            return yield* installationError(
              "remove",
              t("provider.antigravityInstallation.stopSessionsBeforeRemove"),
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binaryPath of protectedBinaryPaths) {
              if (!binaryPath.trim()) continue;
              const selected = yield* resolve(binaryPath).pipe(Effect.option);
              if (Option.isSome(selected) && selected.value.managedVersionDirectory) {
                return yield* installationError(
                  "remove",
                  t("provider.antigravityInstallation.customPathInManagedRuntime"),
                );
              }
              const resolved = yield* fs.realPath(binaryPath).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binaryPath));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`)) {
                return yield* installationError(
                  "remove",
                  t("provider.antigravityInstallation.customPathInManagedRuntime"),
                );
              }
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(wrapFailure("remove", t("provider.antigravityInstallation.removeFailed"))),
  );

  yield* Effect.gen(function* () {
    const canRemove = yield* fs.exists(managedDirectory);
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.releaseId);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      installedVersion: installed.version,
    }));
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: t("provider.antigravityInstallation.managedRuntimeIncompleteRemove"),
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return AntigravityInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});

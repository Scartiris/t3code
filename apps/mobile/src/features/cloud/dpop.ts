import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { p256 } from "@noble/curves/nist";
import { DpopPublicJwk, normalizeDpopHtu } from "@t3tools/shared/dpopCommon";
import { t } from "@t3tools/shared/i18n";
import * as Layer from "effect/Layer";

export class CloudDpopError extends Data.TaggedError("CloudDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function cloudDpopError(message: string) {
  return (cause: unknown) => new CloudDpopError({ message, cause });
}

const DpopPrivateJwkSchema = Schema.Struct({
  ...DpopPublicJwk.fields,
  d: Schema.String,
});

const DpopPrivateJwkJson = Schema.fromJsonString(DpopPrivateJwkSchema);
const decodeDpopPrivateJwkJson = Schema.decodeUnknownEffect(DpopPrivateJwkJson);
const encodeDpopPrivateJwkJson = Schema.encodeEffect(DpopPrivateJwkJson);

const DpopJwtHeaderJson = Schema.fromJsonString(
  Schema.Struct({
    typ: Schema.Literal("dpop+jwt"),
    alg: Schema.Literal("ES256"),
    jwk: DpopPublicJwk,
  }),
);

const DpopJwtPayloadJson = Schema.fromJsonString(
  Schema.Struct({
    htm: Schema.String,
    htu: Schema.String,
    jti: Schema.String,
    iat: Schema.Int,
    ath: Schema.optionalKey(Schema.String),
  }),
);

const encodeDpopJwtHeaderJson = Schema.encodeEffect(DpopJwtHeaderJson);
const encodeDpopJwtPayloadJson = Schema.encodeEffect(DpopJwtPayloadJson);

function toExpoDigestAlgorithm(
  algorithm: Crypto.DigestAlgorithm,
): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm) {
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    case "SHA-384":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA384;
    case "SHA-512":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA512;
  }
}

export const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: ExpoCrypto.getRandomBytes,
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
      }),
  }),
);

type DpopPrivateJwk = typeof DpopPrivateJwkSchema.Type;

export interface DpopProofKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function sha256Digest(
  data: Uint8Array,
  message: string,
): Effect.Effect<Uint8Array, CloudDpopError, Crypto.Crypto> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", data)),
    Effect.mapError(cloudDpopError(message)),
  );
}

function base64UrlSha256(
  data: Uint8Array,
  message: string,
): Effect.Effect<string, CloudDpopError, Crypto.Crypto> {
  return sha256Digest(data, message).pipe(Effect.map(Encoding.encodeBase64Url));
}

function dpopThumbprintInput(jwk: DpopPublicJwk): string {
  return JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

function computeDpopJwkThumbprintEffect(
  jwk: DpopPublicJwk,
): Effect.Effect<string, CloudDpopError, Crypto.Crypto> {
  return base64UrlSha256(
    new TextEncoder().encode(dpopThumbprintInput(jwk)),
    t("cloud.dpop.hashPublicKeyThumbprintFailed"),
  );
}

function computeDpopAccessTokenHashEffect(
  accessToken: string,
): Effect.Effect<string, CloudDpopError, Crypto.Crypto> {
  return base64UrlSha256(
    new TextEncoder().encode(accessToken),
    t("cloud.dpop.hashAccessTokenFailed"),
  );
}

function secureRandomBytes(
  byteCount: number,
  message: string,
): Effect.Effect<Uint8Array, CloudDpopError, Crypto.Crypto> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomBytes(byteCount)),
    Effect.mapError(cloudDpopError(message)),
  );
}

function publicJwkFromUncompressedPublicKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Generated DPoP public key is not an uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Encoding.encodeBase64Url(publicKey.slice(1, 33)),
    y: Encoding.encodeBase64Url(publicKey.slice(33, 65)),
  };
}

function privateJwkFromPrivateKey(
  privateKey: Uint8Array,
  publicJwk: DpopPublicJwk,
): DpopPrivateJwk {
  return { ...publicJwk, d: Encoding.encodeBase64Url(privateKey) };
}

export function generateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    let privateKey: Uint8Array;
    do {
      privateKey = yield* secureRandomBytes(
        p256.CURVE.nByteLength,
        t("cloud.dpop.keyPairRandomnessFailed"),
      );
    } while (!p256.utils.isValidPrivateKey(privateKey));
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(p256.getPublicKey(privateKey, false)),
      catch: cloudDpopError(t("cloud.dpop.generatedPublicKeyInvalid")),
    });
    const thumbprint = yield* computeDpopJwkThumbprintEffect(publicJwk);
    return {
      privateJwk: privateJwkFromPrivateKey(privateKey, publicJwk),
      publicJwk,
      thumbprint,
    };
  });
}

export function loadOrCreateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY),
      catch: cloudDpopError(t("cloud.dpop.readProofKeyFailed")),
    });
    if (stored) {
      const storedPrivateJwk = yield* decodeDpopPrivateJwkJson(stored).pipe(
        Effect.mapError(cloudDpopError(t("cloud.dpop.storedProofKeyInvalid"))),
      );
      const restored = yield* Effect.try({
        try: () => {
          const privateKey = base64UrlToBytes(storedPrivateJwk.d);
          const publicJwk = publicJwkFromUncompressedPublicKey(
            p256.getPublicKey(privateKey, false),
          );
          if (publicJwk.x !== storedPrivateJwk.x || publicJwk.y !== storedPrivateJwk.y) {
            throw new Error("Stored DPoP key does not match its public key.");
          }
          return { privateJwk: storedPrivateJwk, publicJwk };
        },
        catch: cloudDpopError(t("cloud.dpop.storedProofKeyInvalid")),
      });
      const thumbprint = yield* computeDpopJwkThumbprintEffect(restored.publicJwk);
      return {
        ...restored,
        thumbprint,
      };
    }
    const generated = yield* generateDpopProofKeyPair();
    const encodedPrivateJwk = yield* encodeDpopPrivateJwkJson(generated.privateJwk).pipe(
      Effect.mapError(cloudDpopError(t("cloud.dpop.encodeProofKeyFailed"))),
    );
    yield* Effect.tryPromise({
      try: () => SecureStore.setItemAsync(DPOP_PROOF_KEY_STORAGE_KEY, encodedPrivateJwk),
      catch: cloudDpopError(t("cloud.dpop.storeProofKeyFailed")),
    });
    return generated;
  });
}

function normalizeHtu(url: string): Effect.Effect<string, CloudDpopError> {
  const normalized = normalizeDpopHtu(url);
  return normalized
    ? Effect.succeed(normalized)
    : Effect.fail(new CloudDpopError({ message: t("cloud.dpop.urlInvalid") }));
}

export function createDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey?: DpopProofKeyPair;
}): Effect.Effect<
  { readonly proof: string; readonly thumbprint: string },
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const keyPair = input.proofKey ?? (yield* generateDpopProofKeyPair());
    const privateKey = yield* Effect.try({
      try: () => base64UrlToBytes(keyPair.privateJwk.d),
      catch: cloudDpopError(t("cloud.dpop.importPrivateKeyFailed")),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError(cloudDpopError(t("cloud.dpop.generateProofIdentifierFailed"))),
    );
    const htu = yield* normalizeHtu(input.url);
    const header = yield* encodeDpopJwtHeaderJson({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(cloudDpopError(t("cloud.dpop.encodeProofHeaderFailed"))),
    );
    const ath = input.accessToken
      ? yield* computeDpopAccessTokenHashEffect(input.accessToken)
      : null;
    const payload = yield* encodeDpopJwtPayloadJson({
      htm: input.method.toUpperCase(),
      htu,
      jti,
      iat: Math.floor(nowMs / 1_000),
      ...(ath ? { ath } : {}),
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(cloudDpopError(t("cloud.dpop.encodeProofPayloadFailed"))),
    );
    const signatureInputHash = yield* sha256Digest(
      new TextEncoder().encode(`${header}.${payload}`),
      t("cloud.dpop.hashSigningInputFailed"),
    );
    const signature = yield* Effect.try({
      try: () => p256.sign(signatureInputHash, privateKey, { prehash: false }).toCompactRawBytes(),
      catch: cloudDpopError(t("cloud.dpop.signProofFailed")),
    });
    return {
      proof: `${header}.${payload}.${Encoding.encodeBase64Url(signature)}`,
      thumbprint: keyPair.thumbprint,
    };
  });
}

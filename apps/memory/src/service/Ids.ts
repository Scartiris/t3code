// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { MemoryId } from "@t3tools/memory-protocol";

/**
 * `mem_<base36 milliseconds>_<8 hex>`.
 *
 * Time-ordered for the same reason the sequence number is in the event store:
 * an id that sorts by creation makes a log or a dump readable without a join,
 * and the random suffix keeps two entries written in the same millisecond
 * distinct.
 */
export const nextMemoryId = (now: number): MemoryId =>
  MemoryId.make(`mem_${now.toString(36)}_${NodeCrypto.randomBytes(4).toString("hex")}`);

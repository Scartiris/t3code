import * as Schema from "effect/Schema";

import { MemoryErrorCode } from "@t3tools/memory-protocol";

export class MemoryStoreSqlError extends Schema.TaggedError<MemoryStoreSqlError>()(
  "MemoryStoreSqlError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Memory store operation "${this.operation}" failed.`;
  }
}

export class MemoryStoreDecodeError extends Schema.TaggedError<MemoryStoreDecodeError>()(
  "MemoryStoreDecodeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `A stored memory row could not be read back (${this.operation}).`;
  }
}

export class MemoryEntryNotFoundError extends Schema.TaggedError<MemoryEntryNotFoundError>()(
  "MemoryEntryNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `No memory entry with id "${this.id}".`;
  }
}

export class MemoryEntryConflictError extends Schema.TaggedError<MemoryEntryConflictError>()(
  "MemoryEntryConflictError",
  {
    id: Schema.String,
    expectedVersion: Schema.Number,
    actualVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Memory entry "${this.id}" is at version ${this.actualVersion}, not ${this.expectedVersion}.`;
  }
}

export type MemoryStoreError =
  | MemoryStoreSqlError
  | MemoryStoreDecodeError
  | MemoryEntryNotFoundError
  | MemoryEntryConflictError;

/** Maps a store failure onto the wire error code every transport reports. */
export const memoryErrorCodeForStoreError = (error: MemoryStoreError): MemoryErrorCode => {
  switch (error._tag) {
    case "MemoryEntryNotFoundError":
      return "not_found";
    case "MemoryEntryConflictError":
      return "conflict";
    case "MemoryStoreDecodeError":
    case "MemoryStoreSqlError":
      return "internal";
  }
};

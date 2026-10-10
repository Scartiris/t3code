import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MemoryCollection = Schema.Literals(["memory", "knowledge"]);
export type MemoryCollection = typeof MemoryCollection.Type;
const DocumentKey = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Body = TrimmedNonEmptyString.check(Schema.isMaxLength(100_000));
const Kind = Schema.Literals(["fact", "preference", "decision", "reference"]);
const Status = Schema.Literals(["active", "archived", "superseded"]);

/** Workbench management DTOs; the external memory protocol remains independent. */
export const MemoryDocumentSummary = Schema.Struct({
  id: DocumentKey,
  title: Title,
  version: Schema.String,
  kind: Kind,
  scope: Schema.Literals(["global", "project"]),
  projectId: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  status: Status,
  updatedAt: Schema.Number,
});
export type MemoryDocumentSummary = typeof MemoryDocumentSummary.Type;
export const MemoryDocument = Schema.Struct({
  ...MemoryDocumentSummary.fields,
  body: Schema.String,
});
export type MemoryDocument = typeof MemoryDocument.Type;
export const MemoryDocumentsListInput = Schema.Struct({
  collection: MemoryCollection,
  query: Schema.String.check(Schema.isMaxLength(500)),
  status: Status,
  cursor: Schema.optionalKey(Schema.String),
});
export type MemoryDocumentsListInput = typeof MemoryDocumentsListInput.Type;
export const MemoryDocumentsListResult = Schema.Struct({
  items: Schema.Array(MemoryDocumentSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type MemoryDocumentsListResult = typeof MemoryDocumentsListResult.Type;
export const MemoryDocumentReadInput = Schema.Struct({
  collection: MemoryCollection,
  id: DocumentKey,
  status: Status,
});
export type MemoryDocumentReadInput = typeof MemoryDocumentReadInput.Type;
export const MemoryDocumentSaveInput = Schema.Struct({
  collection: MemoryCollection,
  id: Schema.optionalKey(DocumentKey),
  expectedVersion: Schema.optionalKey(TrimmedNonEmptyString),
  status: Status,
  title: Title,
  body: Body,
  kind: Kind,
  scope: Schema.Literals(["global", "project"]),
  projectId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  pinned: Schema.Boolean,
  tags: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(48))).check(
    Schema.isMaxLength(16),
  ),
});
export type MemoryDocumentSaveInput = typeof MemoryDocumentSaveInput.Type;
export const MemoryDocumentArchiveInput = Schema.Struct({
  ...MemoryDocumentReadInput.fields,
  expectedVersion: TrimmedNonEmptyString,
  archived: Schema.Boolean,
});
export type MemoryDocumentArchiveInput = typeof MemoryDocumentArchiveInput.Type;
export class MemoryManagementError extends Schema.TaggedError<MemoryManagementError>()(
  "MemoryManagementError",
  {
    code: Schema.Literals([
      "unavailable",
      "unauthorized",
      "not_found",
      "conflict",
      "invalid_request",
      "internal",
    ]),
    message: Schema.String,
  },
) {}

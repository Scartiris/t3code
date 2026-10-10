import {
  MemoryDocument,
  MemoryDocumentArchiveInput,
  MemoryDocumentReadInput,
  MemoryDocumentSaveInput,
  MemoryDocumentsListInput,
  MemoryDocumentsListResult,
  MemoryManagementError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as MemoryRuntime from "../../../memory/MemoryRuntime.ts";

const shared = {
  failure: MemoryManagementError,
  failureMode: "return" as const,
  dependencies: [MemoryRuntime.MemoryRuntime],
};
const { collection: _listCollection, ...listFields } = MemoryDocumentsListInput.fields;
const { collection: _readCollection, ...readFields } = MemoryDocumentReadInput.fields;
const { collection: _saveCollection, ...saveFields } = MemoryDocumentSaveInput.fields;
const { collection: _archiveCollection, ...archiveFields } = MemoryDocumentArchiveInput.fields;
export const KnowledgeToolkit = Toolkit.make(
  Tool.make("knowledge_search", {
    ...shared,
    description:
      "Browse or semantically search the OpenViking knowledge base. Use query empty to browse, status active for current documents. Results contain summaries; use knowledge_read for content.",
    parameters: Schema.Struct(listFields),
    success: MemoryDocumentsListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("knowledge_read", {
    ...shared,
    description: "Read a knowledge document and its version before editing it.",
    parameters: Schema.Struct(readFields),
    success: MemoryDocument,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("knowledge_save", {
    ...shared,
    description:
      "Create or edit a knowledge document. Edits require the exact expectedVersion from knowledge_read. For documents use kind reference, scope global, projectId null, pinned false, tags empty; memory tools are separate.",
    parameters: Schema.Struct(saveFields),
    success: MemoryDocument,
  }).annotate(Tool.Destructive, true),
  Tool.make("knowledge_archive", {
    ...shared,
    description:
      "Archive a knowledge document to stop active recall, or restore it with archived false. Requires the current version.",
    parameters: Schema.Struct(archiveFields),
    success: MemoryDocument,
  }).annotate(Tool.Destructive, true),
);
export const KnowledgeToolkitHandlersLive = KnowledgeToolkit.toLayer({
  knowledge_search: (input) =>
    MemoryRuntime.MemoryRuntime.pipe(
      Effect.flatMap((runtime) =>
        runtime.management.listDocuments({ ...input, collection: "knowledge" }),
      ),
    ),
  knowledge_read: (input) =>
    MemoryRuntime.MemoryRuntime.pipe(
      Effect.flatMap((runtime) =>
        runtime.management.readDocument({ ...input, collection: "knowledge" }),
      ),
    ),
  knowledge_save: (input) =>
    MemoryRuntime.MemoryRuntime.pipe(
      Effect.flatMap((runtime) =>
        runtime.management.saveDocument({ ...input, collection: "knowledge" }),
      ),
    ),
  knowledge_archive: (input) =>
    MemoryRuntime.MemoryRuntime.pipe(
      Effect.flatMap((runtime) =>
        runtime.management.archiveDocument({ ...input, collection: "knowledge" }),
      ),
    ),
});

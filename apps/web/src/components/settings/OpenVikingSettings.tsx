import type {
  EnvironmentId,
  MemoryCollection,
  MemoryDocument,
  MemoryDocumentSummary,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useBlocker, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@t3tools/shared/i18n";
import { serverEnvironment } from "../../state/server";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Select, SelectPopup, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import ChatMarkdown from "../ChatMarkdown";
import { MemorySettings } from "./MemorySettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const kindLabels = {
  fact: "事实",
  preference: "偏好",
  decision: "决策",
  reference: "参考",
} as const;
const statusLabels = { active: "使用中", archived: "已归档", superseded: "已替代" } as const;
const newDocument = (): MemoryDocument => ({
  id: "",
  version: "",
  title: "",
  body: "",
  kind: "fact",
  scope: "global",
  projectId: null,
  pinned: false,
  tags: [],
  status: "active",
  updatedAt: 0,
});
const failureText = (failure: unknown) => {
  if (failure && typeof failure === "object" && "code" in failure && failure.code === "conflict")
    return "内容已被更新，请重新打开后再编辑。你的修改仍保留在编辑框中。";
  return failure instanceof Error ? failure.message : "操作失败，请检查连接后重试。";
};

function DocumentManager({
  environmentId,
  collection,
  onEditingChange,
}: {
  environmentId: EnvironmentId;
  collection: MemoryCollection;
  onEditingChange: (editing: boolean) => void;
}) {
  const list = useAtomCommand(serverEnvironment.listMemoryDocuments, { reportFailure: false });
  const read = useAtomCommand(serverEnvironment.readMemoryDocument, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.saveMemoryDocument, { reportFailure: false });
  const archive = useAtomCommand(serverEnvironment.archiveMemoryDocument, { reportFailure: false });
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const [items, setItems] = useState<readonly MemoryDocumentSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MemoryDocument["status"]>("active");
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState<MemoryDocument | null>(null);
  const [tagsText, setTagsText] = useState("");
  const isEditing = draft !== null;
  useEffect(() => {
    onEditingChange(isEditing);
    return () => onEditingChange(false);
  }, [isEditing, onEditingChange]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const knowledge = collection === "knowledge";
  const title = knowledge ? "知识库" : "记忆";
  const load = useCallback(
    async (cursor?: string) => {
      const current = ++generation.current;
      setBusy(true);
      setNotice("");
      const result = await list({
        environmentId,
        input: { collection, query: search, status, ...(cursor ? { cursor } : {}) },
      });
      if (current !== generation.current) return;
      if (result._tag === "Success") {
        setItems((previous) =>
          cursor ? [...previous, ...result.value.items] : result.value.items,
        );
        setNextCursor(result.value.nextCursor);
      } else {
        if (!cursor) {
          setItems([]);
          setNextCursor(null);
        }
        setNotice(failureText(squashAtomCommandFailure(result)));
      }
      setBusy(false);
    },
    [collection, environmentId, list, search, status],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const open = async (item: MemoryDocumentSummary) => {
    setBusy(true);
    setNotice("");
    setConfirmArchive(false);
    const current = ++generation.current;
    const result = await read({
      environmentId,
      input: { collection, id: item.id, status: item.status },
    });
    if (current !== generation.current) return;
    if (result._tag === "Success") {
      setSelected(result.value);
      setDraft(null);
    } else setNotice(failureText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice("");
    const current = ++generation.current;
    const result = await save({
      environmentId,
      input: {
        collection,
        ...(draft.id ? { id: draft.id, expectedVersion: draft.version } : {}),
        status: draft.status,
        title: draft.title.trim(),
        body: draft.body.trim(),
        kind: draft.kind,
        scope: draft.scope,
        projectId: draft.scope === "global" ? null : draft.projectId,
        pinned: draft.pinned,
        tags: tagsText
          .split(/[,，]/u)
          .map((tag) => tag.trim())
          .filter(Boolean),
      },
    });
    if (current !== generation.current) return;
    if (result._tag === "Success") {
      setSelected(result.value);
      setDraft(null);
      await load();
      setNotice("已保存，检索索引已更新。");
    } else setNotice(failureText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const changeStatus = async () => {
    if (!selected) return;
    setBusy(true);
    setNotice("");
    const current = ++generation.current;
    const result = await archive({
      environmentId,
      input: {
        collection,
        id: selected.id,
        status: selected.status,
        expectedVersion: selected.version,
        archived: selected.status === "active",
      },
    });
    if (current !== generation.current) return;
    if (result._tag === "Success") {
      setSelected(result.value);
      setConfirmArchive(false);
      await load();
      setNotice(result.value.status === "archived" ? "已归档，可以在“已归档”中恢复。" : "已恢复。");
    } else setNotice(failureText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const edit = (patch: Partial<MemoryDocument>) =>
    setDraft((value) => (value ? { ...value, ...patch } : value));
  return (
    <SettingsSection id={knowledge ? "openviking-knowledge" : "openviking-documents"} title={title}>
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {knowledge
            ? "保存文档、说明和参考资料，支持语义搜索及直接编辑。可新建文档或导入 Markdown、文本文件。"
            : "查看和管理 agent 跨会话使用的事实、偏好与决策。归档后的记忆不再参与召回。"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || draft !== null || status !== "active"}
            onClick={() => {
              setSelected(null);
              setTagsText("");
              setDraft({ ...newDocument(), kind: knowledge ? "reference" : "fact" });
              setNotice("");
            }}
          >
            新建{knowledge ? "文档" : "记忆"}
          </Button>
          {knowledge ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || draft !== null || status !== "active"}
                onClick={() => fileInput.current?.click()}
              >
                导入文本
              </Button>
              <input
                ref={fileInput}
                hidden
                type="file"
                accept=".md,.txt,.markdown,text/plain,text/markdown"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 400_000) {
                    setNotice("文件过大，请选择不超过 100,000 字符的文档。");
                    return;
                  }
                  setBusy(true);
                  const current = ++generation.current;
                  void file
                    .text()
                    .then((body) => {
                      if (current !== generation.current) return;
                      if (body.length > 100_000) {
                        setNotice("文档不能超过 100,000 字符。");
                        return;
                      }
                      setSelected(null);
                      setTagsText("");
                      setDraft({
                        ...newDocument(),
                        kind: "reference",
                        title: file.name.replace(/\.(md|txt|markdown)$/iu, "").slice(0, 120),
                        body,
                      });
                    })
                    .catch(() => setNotice("文件读取失败。"))
                    .finally(() => {
                      if (current === generation.current) setBusy(false);
                    });
                }}
              />
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || draft !== null}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </div>
        <fieldset disabled={busy || draft !== null} className="grid gap-3">
          <ToggleGroup
            variant="segmented"
            value={[status]}
            aria-label="状态"
            onValueChange={(values) => {
              const next = values[0];
              if (next === "active" || next === "archived" || next === "superseded") {
                setStatus(next);
                setSelected(null);
              }
            }}
          >
            <Toggle value="active">使用中</Toggle>
            <Toggle value="archived">已归档</Toggle>
            {!knowledge ? <Toggle value="superseded">已替代</Toggle> : null}
          </ToggleGroup>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (query === search) void load();
              else setSearch(query);
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                size="sm"
                aria-label={`搜索${title}`}
                placeholder={`搜索${title}…`}
                maxLength={500}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button size="sm" variant="outline" type="submit">
              搜索
            </Button>
          </form>
        </fieldset>
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在处理…
          </p>
        ) : null}
        {notice ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="grid content-start gap-2">
            {!busy && !notice && items.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                {search ? "没有找到相关内容。" : `暂无${title}。`}
              </p>
            ) : null}
            {items.map((item) => (
              <div key={item.id}>
                <button
                  type="button"
                  className={`w-full rounded-lg border p-3 text-start disabled:opacity-50 ${selected?.id === item.id ? "bg-muted" : "hover:bg-muted/50"}`}
                  disabled={busy || draft !== null}
                  onClick={() => void open(item)}
                >
                  <span className="grid min-w-0 gap-1 text-start">
                    <span className="truncate">
                      {item.pinned ? "📌 " : ""}
                      {item.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {knowledge
                        ? "文档"
                        : `${kindLabels[item.kind]} · ${item.scope === "global" ? "全局" : (projects.find((project) => project.id === item.projectId)?.title ?? "项目")}`}
                    </span>
                  </span>
                </button>
              </div>
            ))}
            {nextCursor ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || draft !== null}
                onClick={() => void load(nextCursor)}
              >
                加载更多
              </Button>
            ) : null}
          </div>
          <div className="min-w-0">
            {draft ? (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDraft();
                }}
              >
                <fieldset disabled={busy} className="grid gap-3">
                  <Label htmlFor="memory-document-title">标题</Label>
                  <Input
                    id="memory-document-title"
                    required
                    maxLength={120}
                    value={draft.title}
                    onChange={(event) => edit({ title: event.target.value })}
                  />
                  <Label htmlFor="memory-document-body">内容</Label>
                  <Textarea
                    id="memory-document-body"
                    required
                    size="lg"
                    maxLength={knowledge ? 100_000 : 8_000}
                    value={draft.body}
                    onChange={(event) => edit({ body: event.target.value })}
                  />
                  {!knowledge ? (
                    <>
                      <Label>类型</Label>
                      <Select
                        value={draft.kind}
                        onValueChange={(value) => {
                          if (value && value in kindLabels)
                            edit({ kind: value as MemoryDocument["kind"] });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue>{kindLabels[draft.kind]}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {Object.entries(kindLabels).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Label>可见范围</Label>
                      <Select
                        value={draft.scope}
                        onValueChange={(value) => {
                          if (value === "global" || value === "project")
                            edit({
                              scope: value,
                              projectId:
                                value === "global"
                                  ? null
                                  : (draft.projectId ?? projects[0]?.id ?? null),
                            });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {draft.scope === "global" ? "所有项目" : "指定项目"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="global">所有项目</SelectItem>
                          <SelectItem value="project">指定项目</SelectItem>
                        </SelectPopup>
                      </Select>
                      {draft.scope === "project" ? (
                        <>
                          <Label>项目</Label>
                          <Select
                            value={draft.projectId ?? ""}
                            onValueChange={(value) => edit({ projectId: value })}
                          >
                            <SelectTrigger>
                              <SelectValue>
                                {projects.find((project) => project.id === draft.projectId)
                                  ?.title ?? "选择项目"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup>
                              {projects.map((project) => (
                                <SelectItem key={project.id} value={project.id}>
                                  {project.title}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </>
                      ) : null}
                      <div className="flex items-center justify-between">
                        <Label htmlFor="memory-document-pinned">置顶（会话开始时自动载入）</Label>
                        <Switch
                          id="memory-document-pinned"
                          checked={draft.pinned}
                          onCheckedChange={(pinned) => edit({ pinned })}
                        />
                      </div>
                      <Label htmlFor="memory-document-tags">标签（逗号分隔）</Label>
                      <Input
                        id="memory-document-tags"
                        value={tagsText}
                        onChange={(event) => setTagsText(event.target.value)}
                      />
                    </>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      type="submit"
                      disabled={
                        !draft.title.trim() ||
                        !draft.body.trim() ||
                        (draft.scope === "project" && !draft.projectId)
                      }
                    >
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
                      取消
                    </Button>
                  </div>
                </fieldset>
              </form>
            ) : selected ? (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{selected.title}</h3>
                  <span className="text-xs text-muted-foreground">
                    {statusLabels[selected.status]}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDraft(selected);
                      setTagsText(selected.tags.join(", "));
                      setConfirmArchive(false);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      selected.status === "active" ? setConfirmArchive(true) : void changeStatus()
                    }
                  >
                    {selected.status === "active" ? "归档" : "恢复"}
                  </Button>
                </div>
                {confirmArchive ? (
                  <div className="grid gap-2 rounded-lg border p-3">
                    <p className="text-sm">归档后将停止检索此内容，之后可以恢复。</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void changeStatus()}
                      >
                        确认归档
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirmArchive(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : null}
                {!knowledge ? (
                  <p className="text-xs text-muted-foreground">
                    {kindLabels[selected.kind]} ·{" "}
                    {selected.scope === "global"
                      ? "全局"
                      : (projects.find((project) => project.id === selected.projectId)?.title ??
                        "项目")}{" "}
                    · {selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : ""}
                    {selected.tags.length ? ` · ${selected.tags.join("，")}` : ""}
                  </p>
                ) : null}
                <ChatMarkdown
                  text={selected.body}
                  cwd={undefined}
                  environmentId={environmentId}
                  parseRawHtml={false}
                />
              </div>
            ) : (
              <p className="py-6 text-sm text-muted-foreground">
                选择条目查看详情，或新建{knowledge ? "文档" : "记忆"}。
              </p>
            )}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

export function OpenVikingSettingsPanel() {
  const { environment } = useSettingsScope();
  const hash = useLocation({ select: (location) => location.hash });
  const [editing, setEditing] = useState(false);
  useBlocker({
    shouldBlockFn: () => editing && !window.confirm("尚未保存的内容会丢失，确定离开？"),
    enableBeforeUnload: editing,
  });
  const [collection, setCollection] = useState<MemoryCollection>(
    hash === "openviking-knowledge" ? "knowledge" : "memory",
  );
  const [previousHash, setPreviousHash] = useState(hash);
  if (previousHash !== hash) {
    setPreviousHash(hash);
    if (hash === "openviking-knowledge") setCollection("knowledge");
    if (hash === "openviking-documents") setCollection("memory");
  }
  if (!environment)
    return (
      <SettingsPageContainer>
        <p>{t("settings.memory.chooseEnvironment")}</p>
      </SettingsPageContainer>
    );
  return (
    <SettingsPageContainer>
      <div className="flex gap-2">
        <Button
          variant={collection === "knowledge" ? "secondary" : "ghost"}
          disabled={editing}
          onClick={() => setCollection("knowledge")}
        >
          知识库
        </Button>
        <Button
          variant={collection === "memory" ? "secondary" : "ghost"}
          disabled={editing}
          onClick={() => setCollection("memory")}
        >
          记忆
        </Button>
      </div>
      <DocumentManager
        key={`${environment.environmentId}:${collection}`}
        environmentId={environment.environmentId}
        collection={collection}
        onEditingChange={setEditing}
      />
      <details open={hash === "openviking-memory" ? true : undefined}>
        <summary className="cursor-pointer py-3 text-sm font-medium">连接设置</summary>
        <MemorySettings environmentId={environment.environmentId} />
      </details>
    </SettingsPageContainer>
  );
}

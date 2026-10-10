import type { StaticScreenProps } from "@react-navigation/native";
import { usePreventRemove, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MemoryCollection,
  MemoryDocument,
  MemoryDocumentSummary,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { MemorySettings } from "./components/MemorySettings";

const kinds = { fact: "事实", preference: "偏好", decision: "决策", reference: "参考" } as const;
const statuses = { active: "使用中", archived: "已归档", superseded: "已替代" } as const;
const empty = (): MemoryDocument => ({
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
const errorText = (error: unknown) =>
  error && typeof error === "object" && "code" in error && error.code === "conflict"
    ? "内容已被更新，请重新打开后再编辑。你的修改仍保留。"
    : error instanceof Error
      ? error.message
      : "操作失败，请检查连接后重试。";

export function SettingsOpenVikingRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <OpenVikingScreen key={route.params.environmentId} environmentId={route.params.environmentId} />
  );
}

function OpenVikingScreen({ environmentId }: { environmentId: EnvironmentId }) {
  const [collection, setCollection] = useState<MemoryCollection>("memory");
  const [editing, setEditing] = useState(false);
  const [connection, setConnection] = useState(false);
  const navigation = useNavigation();
  usePreventRemove(editing, ({ data }) =>
    Alert.alert("放弃修改？", "尚未保存的内容会丢失。", [
      { text: "继续编辑", style: "cancel" },
      { text: "放弃", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]),
  );
  return (
    <SettingsScreen title="OpenViking">
      <ScreenScrollView>
        <View className="flex-row gap-3 p-4">
          {(["knowledge", "memory"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected: collection === value, disabled: editing }}
              disabled={editing}
              onPress={() => setCollection(value)}
              className="flex-1 rounded-xl bg-card p-3 disabled:opacity-40"
            >
              <Text
                className={
                  collection === value
                    ? "text-center font-t3-medium text-foreground"
                    : "text-center text-foreground-muted"
                }
              >
                {value === "knowledge" ? "知识库" : "记忆"}
              </Text>
            </Pressable>
          ))}
        </View>
        <MobileDocuments
          key={collection}
          environmentId={environmentId}
          collection={collection}
          onEditingChange={setEditing}
        />
        <SettingsSection title="连接设置">
          <SettingsActionRow
            icon="gearshape"
            label={connection ? "收起连接设置" : "展开连接设置"}
            disabled={editing}
            onPress={() => setConnection(!connection)}
          />
        </SettingsSection>
        {connection ? <MemorySettings environmentId={environmentId} disabled={editing} /> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function MobileDocuments({
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
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const knowledge = collection === "knowledge";
  const title = knowledge ? "知识库" : "记忆";
  const isEditing = draft !== null;
  useEffect(() => {
    onEditingChange(isEditing);
    return () => onEditingChange(false);
  }, [isEditing, onEditingChange]);
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
        setNotice(errorText(squashAtomCommandFailure(result)));
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
    const current = ++generation.current;
    setBusy(true);
    setNotice("");
    const result = await read({
      environmentId,
      input: { collection, id: item.id, status: item.status },
    });
    if (current !== generation.current) return;
    if (result._tag === "Success") setSelected(result.value);
    else setNotice(errorText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const saveDraft = async () => {
    if (!draft) return;
    const current = ++generation.current;
    setBusy(true);
    setNotice("");
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
        tags: tags
          .split(/[,，]/u)
          .map((value) => value.trim())
          .filter(Boolean),
        pinned: draft.pinned,
      },
    });
    if (current !== generation.current) return;
    if (result._tag === "Success") {
      setSelected(result.value);
      setDraft(null);
      await load();
      setNotice("已保存，检索索引已更新。");
    } else setNotice(errorText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const changeStatus = async () => {
    if (!selected) return;
    const current = ++generation.current;
    setBusy(true);
    setNotice("");
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
      await load();
      setNotice(result.value.status === "archived" ? "已归档，可在已归档列表中恢复。" : "已恢复。");
    } else setNotice(errorText(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const edit = (patch: Partial<MemoryDocument>) =>
    setDraft((value) => (value ? { ...value, ...patch } : value));
  const locked = busy || draft !== null;
  return (
    <>
      <SettingsSection title={title}>
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            {knowledge
              ? "保存和编辑文档、说明及参考资料，支持语义搜索。"
              : "管理跨会话使用的事实、偏好与决策。归档后不再参与召回。"}
          </Text>
          {notice ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {notice}
            </Text>
          ) : null}
          <AppTextInput
            accessibilityLabel={`搜索${title}`}
            placeholder={`搜索${title}`}
            value={query}
            maxLength={500}
            editable={!locked}
            onChangeText={setQuery}
            onSubmitEditing={() => (query === search ? void load() : setSearch(query))}
            className="rounded-xl bg-card p-3 text-foreground"
          />
        </View>
        <SettingsActionRow
          icon="magnifyingglass"
          label="搜索"
          disabled={locked}
          onPress={() => (query === search ? void load() : setSearch(query))}
        />
        <SettingsActionRow
          icon="plus"
          label={`新建${knowledge ? "文档" : "记忆"}`}
          disabled={locked || status !== "active"}
          onPress={() => {
            setSelected(null);
            setTags("");
            setDraft({ ...empty(), kind: knowledge ? "reference" : "fact" });
          }}
        />
        {(["active", "archived", ...(!knowledge ? ["superseded" as const] : [])] as const).map(
          (value) => (
            <SettingsChoiceRow
              key={value}
              label={statuses[value]}
              description=""
              selected={status === value}
              separated
              disabled={locked}
              onPress={() => {
                setStatus(value);
                setSelected(null);
              }}
            />
          ),
        )}
        <SettingsActionRow
          icon="arrow.clockwise"
          label="刷新"
          disabled={locked}
          loading={busy}
          onPress={() => void load()}
        />
        {!busy && !notice && items.length === 0 ? (
          <View className="p-4">
            <Text className="text-foreground-muted">暂无内容。</Text>
          </View>
        ) : null}
        {items.map((item) => (
          <SettingsActionRow
            key={item.id}
            icon={knowledge ? "doc.text" : "brain"}
            label={`${item.pinned ? "📌 " : ""}${item.title}`}
            disabled={locked}
            onPress={() => void open(item)}
          />
        ))}
        {nextCursor ? (
          <SettingsActionRow
            icon="chevron.down"
            label="加载更多"
            disabled={locked}
            onPress={() => void load(nextCursor)}
          />
        ) : null}
      </SettingsSection>
      {draft ? (
        <SettingsSection title={draft.id ? "编辑内容" : "新建内容"}>
          <View className="gap-3 p-4">
            <Text className="text-foreground-muted">标题</Text>
            <AppTextInput
              accessibilityLabel="标题"
              value={draft.title}
              maxLength={120}
              editable={!busy}
              onChangeText={(title) => edit({ title })}
              className="rounded-xl bg-card p-3 text-foreground"
            />
            <Text className="text-foreground-muted">内容</Text>
            <AppTextInput
              accessibilityLabel="内容"
              value={draft.body}
              maxLength={knowledge ? 100_000 : 8_000}
              editable={!busy}
              multiline
              textAlignVertical="top"
              onChangeText={(body) => edit({ body })}
              className="min-h-48 rounded-xl bg-card p-3 text-foreground"
            />
          </View>
          {!knowledge ? (
            <>
              {Object.entries(kinds).map(([value, label]) => (
                <SettingsChoiceRow
                  key={value}
                  label={label}
                  description=""
                  selected={draft.kind === value}
                  separated
                  disabled={busy}
                  onPress={() => edit({ kind: value as MemoryDocument["kind"] })}
                />
              ))}
              <SettingsChoiceRow
                label="所有项目"
                description="全局记忆"
                selected={draft.scope === "global"}
                separated
                disabled={busy}
                onPress={() => edit({ scope: "global", projectId: null })}
              />
              {projects.map((project) => (
                <SettingsChoiceRow
                  key={project.id}
                  label={project.title}
                  description="项目记忆"
                  selected={draft.scope === "project" && draft.projectId === project.id}
                  separated
                  disabled={busy}
                  onPress={() => edit({ scope: "project", projectId: project.id })}
                />
              ))}
              <SettingsSwitchRow
                icon="pin"
                label="置顶"
                value={draft.pinned}
                disabled={busy}
                onValueChange={(pinned) => edit({ pinned })}
              />
              <View className="gap-2 p-4">
                <Text className="text-foreground-muted">标签（逗号分隔）</Text>
                <AppTextInput
                  accessibilityLabel="标签"
                  value={tags}
                  editable={!busy}
                  onChangeText={setTags}
                  className="rounded-xl bg-card p-3 text-foreground"
                />
              </View>
            </>
          ) : null}
          <SettingsActionRow
            icon="checkmark"
            label="保存"
            disabled={
              busy ||
              !draft.title.trim() ||
              !draft.body.trim() ||
              (draft.scope === "project" && !draft.projectId)
            }
            onPress={() => void saveDraft()}
          />
          <SettingsActionRow
            icon="xmark"
            label="取消"
            disabled={busy}
            onPress={() => setDraft(null)}
          />
        </SettingsSection>
      ) : selected ? (
        <SettingsSection title={selected.title}>
          <View className="gap-3 p-4">
            <Text className="text-sm text-foreground-muted">
              {statuses[selected.status]}
              {knowledge
                ? ""
                : ` · ${kinds[selected.kind]} · ${selected.scope === "global" ? "全局" : (projects.find((project) => project.id === selected.projectId)?.title ?? "项目")}`}
            </Text>
            <Text selectable className="text-base text-foreground">
              {selected.body}
            </Text>
          </View>
          <SettingsActionRow
            icon="pencil"
            label="编辑"
            disabled={busy}
            onPress={() => {
              setDraft(selected);
              setTags(selected.tags.join(", "));
            }}
          />
          <SettingsActionRow
            icon="archivebox"
            label={selected.status === "active" ? "归档" : "恢复"}
            disabled={busy}
            onPress={() =>
              selected.status === "active"
                ? Alert.alert("归档内容？", "归档后停止检索，之后可以恢复。", [
                    { text: "取消", style: "cancel" },
                    { text: "归档", onPress: () => void changeStatus() },
                  ])
                : void changeStatus()
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

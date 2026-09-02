import type { PluginHostProps, PluginSurfaceProps } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  adjustPendingResourceCount,
  ensureResourceWorkspaceRpc,
  type GitHubResource,
  isGitHubResourceDetailStale,
  type LifecycleState,
  listResourcesRpc,
  mergeDetailedResource,
  mergeRefreshedResource,
  normalizeGitHubRepository,
  openExternalUrl,
  refreshResourceRpc,
} from "./github-workbench.shared";
import { useTranslation } from "./i18n/context";
import {
  createResourceIndex,
  type PaseoDirectorySnapshot,
  type ResourceClassification,
  type WorkspaceSnapshot,
} from "./resource-index.shared";

type ResourceScope =
  | { scope: "account" }
  | { scope: "repository"; repository: string };
type WorkbenchProps = PluginSurfaceProps & {
  scope: ResourceScope;
};
type ContentTab = "all" | "issue" | "pull-request" | "mine" | "review";
type OwnershipFilter = "all" | "mine" | "assigned" | "review";
type StatusFilter = LifecycleState;
const WORKBENCH_STALE_TIME_MS = 5 * 60_000;
const RESOURCE_DETAIL_STALE_TIME_MS = 10 * 60_000;

function resourceDetailQueryKey(hostId: string, resourceKey: string | null) {
  return ["github-workbench", hostId, "resource-detail", resourceKey] as const;
}
export function clampWorkbenchListWidth(
  availableWidth: number,
  requestedWidth: number,
) {
  if (availableWidth <= 0) return 0;
  return Math.min(
    availableWidth * 0.7,
    Math.max(availableWidth * 0.3, requestedWidth),
  );
}

export function resourceAccessibilityLabel(
  kind: string,
  repository: string,
  number: number,
  title: string,
) {
  return `${kind} ${repository} #${number}: ${title}`;
}

function usePaseoDirectory(hostId: string) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["github-workbench", hostId, "directory"],
    [hostId],
  );
  const query = useQuery({
    queryKey,
    staleTime: WORKBENCH_STALE_TIME_MS,
    queryFn: async () => {
      const workspaces: WorkspaceSnapshot[] = [];
      const agents: PaseoDirectorySnapshot["agents"] = [];
      let workspaceCursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await paseo.workspaces.list({
          page: {
            limit: 200,
            ...(workspaceCursor ? { cursor: workspaceCursor } : {}),
          },
        });
        workspaces.push(
          ...response.entries.map((workspace) => ({
            id: workspace.id,
            projectId: workspace.projectId,
            projectDisplayName: workspace.projectDisplayName,
            name: workspace.name,
            archivingAt: workspace.archivingAt,
            remoteUrl: workspace.gitRuntime?.remoteUrl ?? null,
            pullRequestNumber: workspace.githubRuntime?.pullRequest?.number,
            worktreeSlug: workspace.worktreeSlug,
            activityAt: workspace.activityAt,
          })),
        );
        workspaceCursor = response.pageInfo.nextCursor ?? undefined;
        if (!workspaceCursor) break;
      }
      let agentCursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await paseo.agents.list({
          page: { limit: 200, ...(agentCursor ? { cursor: agentCursor } : {}) },
        });
        agents.push(
          ...response.entries.map(({ agent }) => ({
            id: agent.id,
            workspaceId: agent.workspaceId,
            title: agent.title,
            status: agent.status,
            requiresAttention: agent.requiresAttention ?? false,
            attentionReason: agent.attentionReason ?? null,
            pendingPermissions: agent.pendingPermissions.length,
            updatedAt: agent.updatedAt,
            labels: agent.labels,
          })),
        );
        agentCursor = response.pageInfo.nextCursor ?? undefined;
        if (!agentCursor) break;
      }
      return { workspaces, agents } satisfies PaseoDirectorySnapshot;
    },
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => queryClient.invalidateQueries({ queryKey }),
        500,
      );
    };
    const stopWorkspaces = paseo.workspaces.subscribe(invalidate);
    const stopAgents = paseo.agents.subscribe(invalidate);
    return () => {
      if (timer) clearTimeout(timer);
      stopWorkspaces();
      stopAgents();
    };
  }, [paseo, queryClient, queryKey]);
  return query;
}

function StatusBadge({
  resource,
  theme,
}: {
  resource: GitHubResource;
  theme: PluginHostProps["theme"];
}) {
  const { t } = useTranslation();
  if (resource.lifecycleState === "merged") {
    return (
      <View
        style={{
          borderColor: "#a371f7",
          borderRadius: 99,
          borderWidth: 1,
          paddingHorizontal: 7,
          paddingVertical: 2,
        }}
      >
        <Text style={{ color: "#a371f7", fontSize: 10, fontWeight: "700" }}>
          {t("resource.badges.merged")}
        </Text>
      </View>
    );
  }
  if (resource.lifecycleState === "closed") {
    return (
      <View
        style={{
          borderColor: theme.colors.statusDanger,
          borderRadius: 99,
          borderWidth: 1,
          paddingHorizontal: 7,
          paddingVertical: 2,
        }}
      >
        <Text
          style={{
            color: theme.colors.statusDanger,
            fontSize: 10,
            fontWeight: "700",
          }}
        >
          {t("resource.badges.closed")}
        </Text>
      </View>
    );
  }
  const draft = resource.kind === "pull-request" && resource.isDraft;
  const color = draft
    ? theme.colors.foregroundMuted
    : theme.colors.statusSuccess;
  return (
    <View
      style={{
        borderColor: color,
        borderRadius: 99,
        borderWidth: 1,
        paddingHorizontal: 7,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: 10, fontWeight: "700" }}>
        {draft ? t("resource.badges.draft") : t("resource.badges.open")}
      </Text>
    </View>
  );
}

function ListRow({
  resource,
  selected,
  onPress,
  theme,
}: {
  resource: GitHubResource;
  selected: boolean;
  onPress: () => void;
  theme: PluginHostProps["theme"];
}) {
  const { t } = useTranslation();
  const kind =
    resource.kind === "pull-request"
      ? t("resource.kind.pullRequest")
      : t("resource.kind.issue");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={resourceAccessibilityLabel(
        kind,
        resource.repository,
        resource.number,
        resource.title,
      )}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        backgroundColor: selected ? theme.colors.surface2 : "transparent",
        borderColor: selected ? theme.colors.border : "transparent",
        borderLeftColor: selected ? theme.colors.accent : "transparent",
        borderLeftWidth: 2,
        borderRadius: 7,
        borderWidth: selected ? 1 : 0,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 11,
      }}
    >
      <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontWeight: "700",
          }}
        >
          {kind} #{resource.number}
        </Text>
        <StatusBadge resource={resource} theme={theme} />
        {resource.kind === "pull-request" && resource.reviewRequestedFromMe ? (
          <Text
            style={{
              color: theme.colors.statusWarning,
              fontSize: 11,
              fontWeight: "700",
            }}
          >
            {t("resource.badges.review")}
          </Text>
        ) : null}
      </View>
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
          lineHeight: 19,
        }}
      >
        {resource.title}
      </Text>
      <Text
        numberOfLines={1}
        style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
      >
        {resource.repository} ·{" "}
        {t("resource.meta.commentsCount", { count: resource.commentCount })}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {t("workbench.updated", {
          date: new Date(resource.updatedAt).toLocaleDateString(),
        })}
      </Text>
    </Pressable>
  );
}

function Body({
  body,
  theme,
}: {
  body: string;
  theme: PluginHostProps["theme"];
}) {
  const { t } = useTranslation();
  if (!body.trim())
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
        {t("resource.meta.noDescription")}
      </Text>
    );
  const occurrences = new Map<string, number>();
  return (
    <View style={{ gap: 7 }}>
      {body
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => {
          const occurrence = (occurrences.get(line) ?? 0) + 1;
          occurrences.set(line, occurrence);
          const key = `${line}-${occurrence}`;
          const heading = /^(#{1,6})\s+(.+)$/.exec(line);
          const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
          const quote = /^>\s?(.*)$/.exec(line);
          if (heading)
            return (
              <Text
                key={key}
                style={{
                  color: theme.colors.foreground,
                  fontSize: heading[1].length < 3 ? 17 : 15,
                  fontWeight: "700",
                  marginTop: occurrence > 1 ? 7 : 0,
                }}
              >
                {heading[2]}
              </Text>
            );
          if (bullet)
            return (
              <Text
                key={key}
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  lineHeight: 21,
                }}
              >
                • {bullet[1]}
              </Text>
            );
          if (quote)
            return (
              <Text
                key={key}
                style={{
                  borderLeftColor: theme.colors.border,
                  borderLeftWidth: 2,
                  color: theme.colors.foregroundMuted,
                  fontSize: 14,
                  lineHeight: 21,
                  paddingLeft: 9,
                }}
              >
                {quote[1]}
              </Text>
            );
          if (!line.trim()) return <View key={key} style={{ height: 5 }} />;
          return (
            <Text
              key={key}
              style={{
                color: theme.colors.foreground,
                fontSize: 14,
                lineHeight: 21,
              }}
            >
              {line}
            </Text>
          );
        })}
    </View>
  );
}

function DetailPane({
  resource,
  theme,
  navigation,
  ensuring,
  onEnsure,
  onRefresh,
  refreshing,
  detailLoading,
  detailError,
  onBack,
}: {
  resource: GitHubResource | null;
  theme: PluginHostProps["theme"];
  navigation: WorkbenchProps["navigation"];
  ensuring: boolean;
  onEnsure: (resource: GitHubResource) => void;
  onRefresh: (resource: GitHubResource) => void;
  refreshing: boolean;
  detailLoading?: boolean;
  detailError?: string | null;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const external = useCallback(async () => {
    if (
      resource &&
      !(await openExternalUrl(resource.url, { linking: Linking }))
    )
      toast.error(
        t("resource.errors.unableToOpenExternal", {
          repository: resource.repository,
          number: resource.number,
        }),
      );
  }, [resource, t, toast]);
  if (!resource)
    return (
      <View
        style={{
          alignItems: "center",
          flex: 1,
          justifyContent: "center",
          padding: 32,
        }}
      >
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 15,
            textAlign: "center",
          }}
        >
          {t("workbench.selectResource")}
        </Text>
      </View>
    );
  const kind =
    resource.kind === "pull-request"
      ? t("resource.kind.pullRequest")
      : t("resource.kind.issue");
  const metadata = [
    `${kind} #${resource.number}`,
    resource.authorLogin ? `@${resource.authorLogin}` : null,
    t("resource.meta.commentsCount", { count: resource.commentCount }),
    resource.kind === "issue" ? resource.milestoneTitle : resource.headRefName,
  ].filter(Boolean);
  return (
    <ScrollView
      contentContainerStyle={{ gap: 18, padding: 20, paddingBottom: 40 }}
      style={{ flex: 1 }}
    >
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workbench.backToList")}
          onPress={onBack}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            ← {t("workbench.backToList")}
          </Text>
        </Pressable>
      ) : null}
      <View
        style={{
          alignItems: "flex-start",
          flexDirection: "row",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <View style={{ flex: 1, gap: 9 }}>
          <View
            style={{
              alignItems: "center",
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 7,
            }}
          >
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              {resource.repository}
            </Text>
            <StatusBadge resource={resource} theme={theme} />
          </View>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 23,
              fontWeight: "700",
              lineHeight: 30,
            }}
          >
            {resource.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {metadata.join(" · ")}
          </Text>
        </View>
        <View style={{ flexDirection: "column", flexShrink: 0, gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              refreshing
                ? t("resource.actions.refreshingItem")
                : t("resource.actions.refreshItem")
            }
            disabled={refreshing}
            onPress={() => onRefresh(resource)}
            style={{
              borderColor: theme.colors.border,
              borderRadius: 6,
              borderWidth: 1,
              opacity: refreshing ? 0.55 : 1,
              paddingHorizontal: 9,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              ↻
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.actions.openOnGitHub")}
            onPress={external}
            style={{
              borderColor: theme.colors.border,
              borderRadius: 6,
              borderWidth: 1,
              paddingHorizontal: 9,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              ↗
            </Text>
          </Pressable>
        </View>
      </View>
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {resource.labels.map((label) => (
          <View
            key={label}
            style={{
              backgroundColor: theme.colors.surface2,
              borderRadius: 99,
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {label}
            </Text>
          </View>
        ))}
        {resource.isMine ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {t("resource.badges.yours")}
          </Text>
        ) : null}
        {resource.isAssignedToMe ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {t("resource.badges.assigned")}
          </Text>
        ) : null}
        {resource.kind === "pull-request" && resource.reviewRequestedFromMe ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
            {t("resource.badges.review")}
          </Text>
        ) : null}
      </View>
      {navigation?.openWorkspace ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              ensuring
                ? t("resource.actions.creatingWorkspace")
                : resource.workspaceIds[0]
                  ? t("resource.actions.openWorkspace")
                  : t("resource.actions.createWorkspace")
            }
            disabled={ensuring}
            onPress={() => onEnsure(resource)}
            style={{
              backgroundColor: theme.colors.accent,
              borderRadius: 7,
              opacity: ensuring ? 0.55 : 1,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Text
              style={{
                color: theme.colors.accentForeground,
                fontSize: 13,
                fontWeight: "700",
              }}
            >
              {ensuring
                ? t("resource.actions.creatingWorkspace")
                : resource.workspaceIds[0]
                  ? t("resource.actions.openWorkspace")
                  : t("resource.actions.createWorkspace")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ backgroundColor: theme.colors.border, height: 1 }} />
      {detailLoading ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {t("workbench.loading")}
        </Text>
      ) : null}
      {detailError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          {detailError}
        </Text>
      ) : null}
      <Body body={resource.body} theme={theme} />
      {resource.kind === "pull-request" ? (
        <View style={{ gap: 7 }}>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              fontWeight: "700",
            }}
          >
            {t("resource.meta.branches", {
              head: resource.headRefName ?? "—",
              base: resource.baseRefName ?? "—",
            })}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {t("resource.meta.review", {
              decision:
                resource.reviewDecision === "approved"
                  ? t("reviewDecision.approved")
                  : resource.reviewDecision === "changes_requested"
                    ? t("reviewDecision.changesRequested")
                    : resource.reviewDecision === "pending"
                      ? t("reviewDecision.reviewRequired")
                      : t("reviewDecision.none"),
            })}
          </Text>
          <Text
            style={{
              color:
                resource.mergeable === "CONFLICTING"
                  ? theme.colors.statusDanger
                  : theme.colors.foregroundMuted,
              fontSize: 12,
            }}
          >
            {t("resource.meta.mergeability", { status: resource.mergeable })}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              fontWeight: "700",
            }}
          >
            {t("checksDetails.title")}
          </Text>
          <Text
            style={{
              color:
                resource.checksStatus === "failure"
                  ? theme.colors.statusDanger
                  : resource.checksStatus === "pending"
                    ? theme.colors.statusWarning
                    : theme.colors.foregroundMuted,
              fontSize: 13,
            }}
          >
            {t(`checksStatus.${resource.checksStatus}`)}
          </Text>
          {resource.checkDetails.map((check) => (
            <View key={check.name} style={{ flexDirection: "row", gap: 8 }}>
              <Text
                style={{
                  color:
                    check.status === "failure"
                      ? theme.colors.statusDanger
                      : check.status === "pending"
                        ? theme.colors.statusWarning
                        : check.status === "success"
                          ? theme.colors.statusSuccess
                          : theme.colors.foregroundMuted,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {t(`checksStatus.${check.status}`)}
              </Text>
              <Text
                style={{
                  color: theme.colors.foreground,
                  flex: 1,
                  fontSize: 12,
                }}
              >
                {check.name}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={{ gap: 5 }}>
          {resource.milestoneTitle ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {resource.milestoneTitle}
            </Text>
          ) : null}
          {resource.assigneeLogins.length ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t("resource.meta.assignees", {
                assignees: resource.assigneeLogins
                  .map((login) => `@${login}`)
                  .join(", "),
              })}
            </Text>
          ) : null}
        </View>
      )}
      {resource.agents[0] && navigation ? (
        <View
          style={{
            alignItems: "center",
            borderTopColor: theme.colors.border,
            borderTopWidth: 1,
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            paddingTop: 16,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.actions.openAgent")}
            onPress={() =>
              navigation.openAgent({ agentId: resource.agents[0].id })
            }
            style={{ paddingHorizontal: 5, paddingVertical: 8 }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
              {t("resource.actions.openAgent")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}
function FilterIcon({ color }: { color: string }) {
  return (
    <View
      style={{
        alignItems: "center",
        height: 16,
        justifyContent: "center",
        width: 16,
      }}
    >
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: 2,
          width: 16,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: 2,
          marginTop: 2,
          width: 10,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: 6,
          marginTop: 2,
          width: 3,
        }}
      />
    </View>
  );
}

function FilterPopover({
  theme,
  status,
  bucket,
  ownership,
  repository,
  repositories,
  showRepositoryFilter,
  setStatus,
  setBucket,
  setOwnership,
  setRepository,
}: {
  theme: PluginHostProps["theme"];
  status: StatusFilter;
  bucket: ResourceClassification["bucket"] | "all";
  ownership: OwnershipFilter;
  repository: string | null;
  repositories: readonly string[];
  showRepositoryFilter: boolean;
  setStatus: (value: StatusFilter) => void;
  setBucket: (value: ResourceClassification["bucket"] | "all") => void;
  setOwnership: (value: OwnershipFilter) => void;
  setRepository: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const button = (selected: boolean) => ({
    backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface0,
    borderColor: theme.colors.border,
    borderRadius: 99,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  });
  const statusOptions: Array<{ key: StatusFilter; label: string }> = [
    { key: "open", label: t("filters.status.open") },
    { key: "merged", label: t("filters.status.merged") },
    { key: "closed", label: t("filters.status.closed") },
  ];
  const bucketOptions = [
    "all",
    "needs-attention",
    "being-handled",
    "waiting",
    "ready",
    "open",
  ] as const;
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        borderWidth: 1,
        elevation: 8,
        gap: 9,
        padding: 10,
        shadowColor: "#000",
        shadowOffset: { height: 4, width: 0 },
        shadowOpacity: 0.28,
        shadowRadius: 10,
      }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
        }}
      >
        {t("workbench.filterStatus")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {statusOptions.map((opt) => (
          <Pressable
            key={opt.key}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: status === opt.key }}
            onPress={() => setStatus(opt.key)}
            style={button(status === opt.key)}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {showRepositoryFilter && repositories.length > 1 ? (
        <>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              fontWeight: "700",
            }}
          >
            {t("workbench.filterRepository")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("filters.kinds.all")}
              accessibilityState={{ selected: repository === null }}
              onPress={() => setRepository(null)}
              style={button(repository === null)}
            >
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
              >
                {t("filters.kinds.all")}
              </Text>
            </Pressable>
            {repositories.map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={value}
                accessibilityState={{ selected: repository === value }}
                onPress={() => setRepository(value)}
                style={button(repository === value)}
              >
                <Text
                  style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
                >
                  {value}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
        }}
      >
        {t("workbench.filterWorkflow")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {bucketOptions.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={
              value === "all"
                ? t("filters.buckets.all")
                : t(
                    `filters.buckets.${value === "needs-attention" ? "needsAttention" : value === "being-handled" ? "beingHandled" : value}`,
                  )
            }
            accessibilityState={{ selected: bucket === value }}
            onPress={() => setBucket(value)}
            style={button(bucket === value)}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {value === "all"
                ? t("filters.buckets.all")
                : t(
                    `filters.buckets.${value === "needs-attention" ? "needsAttention" : value === "being-handled" ? "beingHandled" : value}`,
                  )}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
        }}
      >
        {t("workbench.filterOwnership")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["all", "mine", "assigned", "review"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={
              value === "all"
                ? t("filters.kinds.all")
                : value === "mine"
                  ? t("filters.mine")
                  : value === "assigned"
                    ? t("resource.badges.assigned")
                    : t("resource.badges.review")
            }
            accessibilityState={{ selected: ownership === value }}
            onPress={() => setOwnership(value)}
            style={button(ownership === value)}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {value === "all"
                ? t("filters.kinds.all")
                : value === "mine"
                  ? t("filters.mine")
                  : value === "assigned"
                    ? t("resource.badges.assigned")
                    : t("resource.badges.review")}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Workbench({
  theme,
  layout,
  host,
  navigation,
  scope,
}: WorkbenchProps) {
  const { t } = useTranslation();
  const listResources = useRpc(listResourcesRpc);
  const refreshResource = useRpc(refreshResourceRpc);
  const ensureResourceWorkspace = useRpc(ensureResourceWorkspaceRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<ContentTab>("all");
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [bucket, setBucket] = useState<
    ResourceClassification["bucket"] | "all"
  >("all");
  const [ownership, setOwnership] = useState<OwnershipFilter>("all");
  const [repository, setRepository] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [pendingCounts, setPendingCounts] = useState(
    () => new Map<string, number>(),
  );
  const [listWidth, setListWidth] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const dragStartWidth = useRef(0);
  const dragStartPageX = useRef(0);
  const directory = usePaseoDirectory(host.id);
  const queryKey = [
    "github-workbench",
    host.id,
    scope.scope,
    scope.scope === "repository" ? scope.repository : null,
    status,
  ] as const;
  const scopeKey =
    scope.scope === "repository" ? `repository:${scope.repository}` : "account";
  const query = useQuery({
    queryKey,
    staleTime: WORKBENCH_STALE_TIME_MS,
    refetchInterval: WORKBENCH_STALE_TIME_MS,
    refetchIntervalInBackground: false,
    queryFn: () =>
      listResources(
        scope.scope === "repository"
          ? { scope: "repository", repository: scope.repository, state: status }
          : { scope: "account", state: status },
      ),
  });
  const index = useMemo(
    () => createResourceIndex(query.data?.resources ?? [], directory.data),
    [directory.data, query.data?.resources],
  );
  const repositories = useMemo(
    () =>
      [...new Set(index.resources.map((resource) => resource.repository))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [index.resources],
  );
  useEffect(() => {
    void scopeKey;
    setRepository(null);
    setSelectedKey(null);
  }, [scopeKey]);
  useEffect(() => {
    if (repository && !repositories.includes(repository)) setRepository(null);
    if (
      selectedKey &&
      !index.resources.some((resource) => resource.key === selectedKey)
    ) {
      setSelectedKey(null);
    }
  }, [index.resources, repository, repositories, selectedKey]);
  const rows = useMemo(
    () =>
      index
        .query({
          focusKey: null,
          quickFilter: null,
          kind:
            tab === "issue"
              ? "issue"
              : tab === "pull-request" || tab === "review"
                ? "pull-request"
                : "all",
          lifecycleState: status,
          bucket,
          label: null,
          milestone: null,
          search,
          sort: "updated",
          direction: "desc",
        })
        .items.filter(
          ({ resource }) =>
            (!repository || resource.repository === repository) &&
            !((tab === "mine" || ownership === "mine") && !resource.isMine) &&
            !(
              (tab === "review" || ownership === "review") &&
              !(
                resource.kind === "pull-request" &&
                resource.reviewRequestedFromMe
              )
            ) &&
            !(ownership === "assigned" && !resource.isAssignedToMe),
        ),
    [bucket, index, ownership, repository, search, status, tab],
  );
  const selected =
    rows.find((item) => item.resource.key === selectedKey)?.resource ?? null;
  const selectedDetailQuery = useQuery({
    queryKey: resourceDetailQueryKey(host.id, selected?.key ?? null),
    enabled: selected !== null,
    staleTime: RESOURCE_DETAIL_STALE_TIME_MS,
    queryFn: async () => {
      if (!selected) throw new Error("No GitHub resource is selected.");
      return refreshResource({
        kind: selected.kind,
        repository: selected.repository,
        number: selected.number,
      });
    },
  });
  const detailResource = selectedDetailQuery.data?.resource;
  const selectedResourceKey = selected?.key ?? null;
  const selectedUpdatedAt = selected?.updatedAt ?? null;
  const selectedChecksStatus =
    selected?.kind === "pull-request" ? selected.checksStatus : null;
  const detailIsBehindSummary = Boolean(
    selected &&
      detailResource &&
      isGitHubResourceDetailStale(
        selected,
        detailResource,
        query.dataUpdatedAt,
        selectedDetailQuery.dataUpdatedAt,
      ),
  );
  const selectedForDetail =
    selected && detailResource && !detailIsBehindSummary
      ? mergeDetailedResource(selected, detailResource)
      : selected;
  const staleDetailVersion =
    detailIsBehindSummary && selectedResourceKey && selectedUpdatedAt
      ? `${selectedResourceKey}:${selectedUpdatedAt}:${selectedChecksStatus ?? ""}`
      : null;
  useEffect(() => {
    if (!selectedResourceKey || !staleDetailVersion) return;
    void queryClient.invalidateQueries({
      queryKey: resourceDetailQueryKey(host.id, selectedResourceKey),
      refetchType: "active",
    });
  }, [host.id, queryClient, selectedResourceKey, staleDetailVersion]);
  useEffect(() => {
    if (
      selectedKey &&
      !rows.some((item) => item.resource.key === selectedKey)
    ) {
      setSelectedKey(null);
    }
  }, [rows, selectedKey]);
  const showingDetail = layout.compact && selected !== null;
  const count = (contentTab: ContentTab) =>
    index.resources.filter(
      (resource) =>
        contentTab === "all" ||
        (contentTab === "issue" && resource.kind === "issue") ||
        (contentTab === "pull-request" && resource.kind === "pull-request") ||
        (contentTab === "mine" && resource.isMine) ||
        (contentTab === "review" &&
          resource.kind === "pull-request" &&
          resource.reviewRequestedFromMe),
    ).length;
  const refresh = useCallback(() => {
    listResources(
      scope.scope === "repository"
        ? {
            scope: "repository",
            repository: scope.repository,
            state: status,
            forceRefresh: true,
          }
        : { scope: "account", state: status, forceRefresh: true },
    )
      .then((data) => {
        queryClient.setQueryData(queryKey, data);
      })
      .catch(() => undefined);
  }, [listResources, queryClient, queryKey, scope, status]);
  const refreshItem = useCallback(
    (resource: GitHubResource) => {
      setRefreshingKey(resource.key);
      void queryClient.cancelQueries({
        queryKey: resourceDetailQueryKey(host.id, resource.key),
      });
      refreshResource({
        kind: resource.kind,
        repository: resource.repository,
        number: resource.number,
      })
        .then(({ resource: refreshed }) => {
          queryClient.setQueryData(
            queryKey,
            (current: { resources?: GitHubResource[] } | undefined) =>
              current
                ? {
                    ...current,
                    resources: current.resources?.map((item) =>
                      item.key === refreshed.key
                        ? mergeRefreshedResource(item, refreshed)
                        : item,
                    ),
                  }
                : current,
          );
          queryClient.setQueryData(
            resourceDetailQueryKey(host.id, resource.key),
            { resource: refreshed },
          );
          setRefreshingKey(null);
        })
        .catch(() => {
          setRefreshingKey(null);
          toast.error(t("resource.toasts.refreshFailed"));
        });
    },
    [host.id, queryClient, queryKey, refreshResource, t, toast],
  );
  const ensure = useCallback(
    (resource: GitHubResource) => {
      setPendingCounts((counts) =>
        adjustPendingResourceCount(counts, resource.key, 1),
      );
      ensureResourceWorkspace({
        kind: resource.kind,
        repository: resource.repository,
        number: resource.number,
        title: resource.title,
      })
        .then((result) => {
          setPendingCounts((counts) =>
            adjustPendingResourceCount(counts, resource.key, -1),
          );
          if (
            (result.action === "opened" || result.action === "created") &&
            result.workspaceId
          ) {
            navigation?.openWorkspace?.({ workspaceId: result.workspaceId });
            toast.show(
              result.action === "created"
                ? t("resource.toasts.workspaceCreated")
                : t("resource.toasts.workspaceOpened"),
              { variant: "success" },
            );
            queryClient.invalidateQueries({
              queryKey: ["github-workbench", host.id, "directory"],
            });
            return;
          }
          toast.error(
            t(
              result.action === "local-project-not-found"
                ? "resource.errors.localProjectNotFound"
                : result.action === "base-branch-unavailable"
                  ? "resource.errors.baseBranchUnavailable"
                  : "resource.errors.ensureWorkspaceFailed",
            ),
          );
        })
        .catch((error) => {
          setPendingCounts((counts) =>
            adjustPendingResourceCount(counts, resource.key, -1),
          );
          toast.error(
            error instanceof Error
              ? error.message
              : t("resource.errors.ensureWorkspaceFailed"),
          );
        });
    },
    [ensureResourceWorkspace, host.id, navigation, queryClient, t, toast],
  );
  const tabs: Array<{ key: ContentTab; label: string }> = [
    { key: "all", label: t("filters.kinds.all") },
    { key: "issue", label: t("filters.kinds.issue") },
    { key: "pull-request", label: t("filters.kinds.pullRequest") },
    { key: "mine", label: t("filters.mine") },
    { key: "review", label: t("resource.badges.review") },
  ];
  const activeListWidth =
    listWidth ?? clampWorkbenchListWidth(containerWidth, containerWidth * 0.5);
  const list = (
    <View
      style={{
        borderRightColor: theme.colors.border,
        borderRightWidth: layout.compact ? 0 : 1,
        flexBasis: layout.compact ? undefined : activeListWidth,
        flexGrow: layout.compact ? 0 : 0,
        flexShrink: 0,
        minHeight: layout.compact ? 300 : undefined,
      }}
    >
      <View
        style={{
          borderBottomColor: theme.colors.border,
          borderBottomWidth: 1,
          gap: 12,
          padding: layout.compact ? 12 : 16,
          position: "relative",
          zIndex: filterOpen ? 20 : 1,
        }}
      >
        <View
          style={{
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 4 }}
            style={{ flex: 1 }}
          >
            {tabs.map(({ key, label }) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: tab === key }}
                onPress={() => setTab(key)}
                style={{
                  borderBottomColor:
                    tab === key ? theme.colors.accent : "transparent",
                  borderBottomWidth: 2,
                  paddingHorizontal: 7,
                  paddingVertical: 5,
                }}
              >
                <Text
                  style={{
                    color:
                      tab === key
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted,
                    fontSize: 12,
                    fontWeight: tab === key ? "700" : "500",
                  }}
                >
                  {label} ({count(key)})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workbench.refresh")}
            onPress={refresh}
            style={{ paddingHorizontal: 3, paddingVertical: 5 }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 15 }}>
              ↻
            </Text>
          </Pressable>
        </View>
        <View
          style={{
            alignItems: "center",
            flexDirection: "row",
            gap: 8,
            position: "relative",
            zIndex: filterOpen ? 20 : 1,
          }}
        >
          <TextInput
            accessibilityLabel={t("workbench.searchAriaLabel")}
            value={search}
            onChangeText={setSearch}
            placeholder={t("workbench.searchPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
              borderRadius: 7,
              borderWidth: 1,
              color: theme.colors.foreground,
              flex: 1,
              fontSize: 13,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workbench.filters")}
            accessibilityState={{ expanded: filterOpen }}
            onPress={() => setFilterOpen((open) => !open)}
            style={{
              alignItems: "center",
              backgroundColor: filterOpen
                ? theme.colors.surface2
                : theme.colors.surface1,
              borderColor: theme.colors.border,
              borderRadius: 7,
              borderWidth: 1,
              height: 36,
              justifyContent: "center",
              width: 36,
            }}
          >
            <FilterIcon color={theme.colors.foreground} />
          </Pressable>
          {filterOpen ? (
            <View
              style={{
                elevation: 10,
                maxWidth: "100%",
                position: "absolute",
                right: 0,
                top: 42,
                width: layout.compact ? "100%" : 408,
                zIndex: 30,
              }}
            >
              <FilterPopover
                theme={theme}
                status={status}
                bucket={bucket}
                ownership={ownership}
                repository={repository}
                repositories={repositories}
                showRepositoryFilter={scope.scope === "account"}
                setStatus={setStatus}
                setBucket={setBucket}
                setOwnership={setOwnership}
                setRepository={setRepository}
              />
            </View>
          ) : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {t("summary.total", { count: rows.length })}
        </Text>
      </View>
      {query.data?.warnings.map((warning) => (
        <Text
          key={warning.code}
          style={{
            color: theme.colors.statusWarning,
            fontSize: 12,
            paddingHorizontal: 16,
            paddingTop: 10,
          }}
        >
          {warning.message}
        </Text>
      ))}
      {query.isLoading ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.foregroundMuted, padding: 16 }}
        >
          {t("workbench.loading")}
        </Text>
      ) : null}
      {query.error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.statusDanger, padding: 16 }}
        >
          {query.error instanceof Error
            ? query.error.message
            : t("workbench.unableToLoad")}
        </Text>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={({ resource }) => resource.key}
        renderItem={({ item }) => (
          <ListRow
            resource={item.resource}
            selected={selectedKey === item.resource.key}
            onPress={() => setSelectedKey(item.resource.key)}
            theme={theme}
          />
        )}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        contentContainerStyle={{ gap: 2, padding: 8 }}
        style={{ flex: 1 }}
        ListEmptyComponent={
          !query.isLoading ? (
            <Text style={{ color: theme.colors.foregroundMuted, padding: 14 }}>
              {t("workbench.empty")}
            </Text>
          ) : null
        }
      />
    </View>
  );
  return (
    <View style={{ backgroundColor: theme.colors.surface0, flex: 1 }}>
      {showingDetail ? (
        <DetailPane
          resource={selectedForDetail}
          theme={theme}
          navigation={navigation}
          refreshing={
            refreshingKey === selected?.key || selectedDetailQuery.isFetching
          }
          detailLoading={
            selectedDetailQuery.isFetching && !selectedDetailQuery.data
          }
          detailError={
            selectedDetailQuery.error instanceof Error
              ? selectedDetailQuery.error.message
              : selectedDetailQuery.error
                ? t("workbench.unableToLoad")
                : null
          }
          onRefresh={refreshItem}
          ensuring={
            selected ? (pendingCounts.get(selected.key) ?? 0) > 0 : false
          }
          onEnsure={ensure}
          onBack={() => setSelectedKey(null)}
        />
      ) : layout.compact ? (
        <View style={{ flex: 1, flexDirection: "column" }}>
          {list}
          <View
            style={{
              backgroundColor: theme.colors.surface0,
              flex: 1,
              minHeight: 360,
            }}
          >
            <DetailPane
              resource={selectedForDetail}
              theme={theme}
              navigation={navigation}
              refreshing={
                refreshingKey === selected?.key ||
                selectedDetailQuery.isFetching
              }
              detailLoading={
                selectedDetailQuery.isFetching && !selectedDetailQuery.data
              }
              detailError={
                selectedDetailQuery.error instanceof Error
                  ? selectedDetailQuery.error.message
                  : selectedDetailQuery.error
                    ? t("workbench.unableToLoad")
                    : null
              }
              onRefresh={refreshItem}
              ensuring={
                selected ? (pendingCounts.get(selected.key) ?? 0) > 0 : false
              }
              onEnsure={ensure}
            />
          </View>
        </View>
      ) : (
        <View
          onLayout={({ nativeEvent }) => {
            const availableWidth = Math.max(0, nativeEvent.layout.width - 10);
            setContainerWidth(availableWidth);
            setListWidth((current) =>
              clampWorkbenchListWidth(
                availableWidth,
                current ?? availableWidth * 0.5,
              ),
            );
          }}
          style={{ flex: 1, flexDirection: "row" }}
        >
          {list}
          <View
            accessibilityActions={[
              { name: "increment", label: t("workbench.expandList") },
              { name: "decrement", label: t("workbench.shrinkList") },
            ]}
            accessibilityLabel={t("workbench.resizeDivider")}
            accessibilityRole="adjustable"
            accessibilityValue={{
              min: 30,
              max: 70,
              now: containerWidth
                ? Math.round((activeListWidth / containerWidth) * 100)
                : 50,
            }}
            onAccessibilityAction={({ nativeEvent }) => {
              const change = nativeEvent.actionName === "increment" ? 24 : -24;
              setListWidth((current) =>
                clampWorkbenchListWidth(
                  containerWidth,
                  (current ?? containerWidth * 0.5) + change,
                ),
              );
            }}
            onResponderGrant={({ nativeEvent }) => {
              dragStartPageX.current = nativeEvent.pageX;
              dragStartWidth.current = activeListWidth;
            }}
            onResponderMove={({ nativeEvent }) => {
              setListWidth(
                clampWorkbenchListWidth(
                  containerWidth,
                  dragStartWidth.current +
                    nativeEvent.pageX -
                    dragStartPageX.current,
                ),
              );
            }}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            style={{
              alignItems: "center",
              justifyContent: "center",
              cursor: "col-resize" as never,
              width: 10,
            }}
          >
            <View
              style={{
                backgroundColor: theme.colors.border,
                borderRadius: 2,
                height: "100%",
                width: 2,
              }}
            />
          </View>
          <View style={{ backgroundColor: theme.colors.surface0, flex: 1 }}>
            <DetailPane
              resource={selectedForDetail}
              theme={theme}
              navigation={navigation}
              refreshing={
                refreshingKey === selected?.key ||
                selectedDetailQuery.isFetching
              }
              detailLoading={
                selectedDetailQuery.isFetching && !selectedDetailQuery.data
              }
              detailError={
                selectedDetailQuery.error instanceof Error
                  ? selectedDetailQuery.error.message
                  : selectedDetailQuery.error
                    ? t("workbench.unableToLoad")
                    : null
              }
              onRefresh={refreshItem}
              ensuring={
                selected ? (pendingCounts.get(selected.key) ?? 0) > 0 : false
              }
              onEnsure={ensure}
            />
          </View>
        </View>
      )}
    </View>
  );
}

export function useProjectRepositories(
  projectId: string | null,
  hostId: string,
  initialRepository: string | null = null,
) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["github-workbench", hostId, "project-repositories", projectId],
    [hostId, projectId],
  );
  const query = useQuery({
    queryKey,
    enabled: Boolean(projectId),
    staleTime: WORKBENCH_STALE_TIME_MS,
    queryFn: async () => {
      if (!projectId) return [];
      const repositories = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await paseo.workspaces.list({
          filter: { projectId },
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const workspace of response.entries) {
          if (workspace.archivingAt) continue;
          const repository = normalizeGitHubRepository(
            workspace.gitRuntime?.remoteUrl,
          );
          if (repository) repositories.add(repository);
        }
        cursor = response.pageInfo.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return [...repositories].sort((left, right) => left.localeCompare(right));
    },
  });
  useEffect(() => {
    const invalidate = () => queryClient.invalidateQueries({ queryKey });
    return paseo.workspaces.subscribe(invalidate);
  }, [paseo, queryClient, queryKey]);
  return useMemo(() => {
    const loaded = query.data ?? [];
    if (!initialRepository) return loaded;
    const initialLower = initialRepository.toLowerCase();
    return [
      initialRepository,
      ...loaded.filter(
        (repository) => repository.toLowerCase() !== initialLower,
      ),
    ];
  }, [initialRepository, query.data]);
}

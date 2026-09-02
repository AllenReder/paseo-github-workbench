import type { PluginHostProps, PluginSurfaceProps } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import {
  adjustPendingResourceCount,
  diagnosticsRpc,
  ensureResourceWorkspaceRpc,
  type GitHubResource,
  listResourcesRpc,
  mergeRefreshedResource,
  normalizeGitHubRepository,
  openExternalUrl,
  type ResourceKind,
  refreshResourceRpc,
} from "./github-workbench.shared";
import type { Translator } from "./i18n";
import { useTranslation } from "./i18n/context";
import {
  type AgentSnapshot,
  createResourceIndex,
  type IndexedResource,
  type MilestoneFilter,
  type PaseoDirectorySnapshot,
  type QuickResourceFilter,
  type ResourceClassification,
  type ResourceSortDimension,
  type ResourceSortDirection,
  type WorkspaceSnapshot,
} from "./resource-index.shared";

type ResourceScope =
  | { scope: "account" }
  | { scope: "repository"; repository: string };

type WorkbenchProps = PluginSurfaceProps & {
  scope: ResourceScope | null;
  showDiagnostics?: boolean;
};

const REASON_KEY_MAP: Record<string, string> = {
  "Agent needs attention": "reasons.agentNeedsAttention",
  "Agent failed": "reasons.agentFailed",
  "Agent is working": "reasons.agentIsWorking",
  "Checks running": "reasons.checksRunning",
  "Your review requested": "reasons.yourReviewRequested",
  "Checks failing": "reasons.checksFailing",
  "Changes needed": "reasons.changesNeeded",
  "Ready to merge": "reasons.readyToMerge",
  "Waiting for GitHub activity": "reasons.waitingForActivity",
  "Waiting for review": "reasons.waitingForReview",
  "Waiting for mergeability": "reasons.waitingForMergeability",
  "Assigned to you": "reasons.assignedToYou",
  "Open issue": "reasons.openIssue",
};

export function localizeReason(reason: string, t: Translator): string {
  const key = REASON_KEY_MAP[reason];
  return key ? t(key, undefined, reason) : reason;
}

export function localizeChecksStatus(status: string, t: Translator): string {
  const key = `checksStatus.${status}`;
  return t(key, undefined, status);
}

export function localizeReviewDecision(
  decision: string,
  t: Translator,
): string {
  const camelKey = decision.replace(/_([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  );
  const key = `reviewDecision.${camelKey}`;
  return t(key, undefined, decision.replace(/_/g, " "));
}

function usePaseoDirectory(hostId: string) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const directoryQueryKey = useMemo(
    () => ["github-workbench", hostId, "directory"],
    [hostId],
  );
  const query = useQuery({
    queryKey: directoryQueryKey,
    queryFn: async () => {
      const workspaces = [] as WorkspaceSnapshot[];
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
      const agents = [] as AgentSnapshot[];
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
    staleTime: 0,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: directoryQueryKey,
        });
      }, 500);
    };
    const stopWorkspaces = paseo.workspaces.subscribe(invalidate);
    const stopAgents = paseo.agents.subscribe(invalidate);
    return () => {
      if (timer) clearTimeout(timer);
      stopWorkspaces();
      stopAgents();
    };
  }, [directoryQueryKey, paseo, queryClient]);

  return query;
}
function diagnosticsStatusText(
  status: "ok" | "auth-required" | "rate-limited" | "unavailable" | undefined,
  t: Translator,
) {
  if (status === "ok") return t("diagnostics.statusHealthy");
  if (status === "auth-required")
    return t("diagnostics.statusNotAuthenticated");
  if (status === "rate-limited") return t("diagnostics.statusRateLimited");
  return t("diagnostics.statusError");
}

export function GitHubDiagnosticsStatus({
  hostId,
  theme,
  compact,
}: {
  hostId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const { t } = useTranslation();
  const diagnostics = useRpc(diagnosticsRpc);
  const queryClient = useQueryClient();
  const diagnosticsQuery = useQuery({
    queryKey: ["github-workbench", hostId, "diagnostics"],
    queryFn: () => diagnostics({}),
    staleTime: 30_000,
  });
  const [rechecking, setRechecking] = useState(false);
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const value = await diagnostics({ forceRefresh: true });
      queryClient.setQueryData(
        ["github-workbench", hostId, "diagnostics"],
        value,
      );
    } finally {
      setRechecking(false);
    }
  }, [diagnostics, hostId, queryClient]);
  const data = diagnosticsQuery.data;
  const statusText = diagnosticsStatusText(data?.status, t);
  const statusColor =
    data?.status === "ok"
      ? theme.colors.statusSuccess
      : data?.status === "rate-limited"
        ? theme.colors.statusWarning
        : theme.colors.statusDanger;

  return (
    <View
      style={{
        alignItems: "center",
        flexDirection: "row",
        flexShrink: 1,
        gap: compact ? 6 : 8,
      }}
    >
      <View
        accessible
        accessibilityLabel={statusText}
        style={{
          backgroundColor: statusColor,
          borderRadius: 999,
          height: 8,
          width: 8,
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foreground,
          fontSize: 12,
          fontWeight: "700",
        }}
      >
        {data?.viewerLogin ? `@${data.viewerLogin}` : t("diagnostics.noViewer")}
      </Text>
      <Text
        numberOfLines={1}
        style={{ color: statusColor, flexShrink: 1, fontSize: 12 }}
      >
        {statusText}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("diagnostics.recheck")}
        accessibilityState={{ disabled: rechecking }}
        disabled={rechecking}
        onPress={recheck}
        style={{
          borderColor: theme.colors.border,
          borderRadius: 8,
          borderWidth: 1,
          opacity: rechecking ? 0.6 : 1,
          paddingHorizontal: 8,
          paddingVertical: compact ? 5 : 6,
        }}
      >
        <Text
          style={{
            color: theme.colors.accent,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {t("diagnostics.recheck")}
        </Text>
      </Pressable>
    </View>
  );
}
function FilterChip({
  label,
  selected,
  onPress,
  styles,
  theme,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  styles: { chip: ViewStyle; activeChip: ViewStyle };
  theme: PluginHostProps["theme"];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.activeChip]}
    >
      <Text
        style={{
          color: selected
            ? theme.colors.surface0
            : theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        alignItems: "center",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 6,
      }}
    >
      {children}
    </View>
  );
}

export function resourceAccessibilityLabel(
  kind: string,
  repository: string,
  number: number,
  title: string,
): string {
  return `${kind} ${repository} #${number}: ${title}`;
}

function PullRequestChecks({
  resource,
  theme,
}: {
  resource: Extract<GitHubResource, { kind: "pull-request" }>;
  theme: PluginHostProps["theme"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const checks = [...resource.checkDetails].sort((left, right) => {
    const rank = (status: string) =>
      status === "failure" ? 0 : status === "pending" ? 1 : 2;
    return (
      rank(left.status) - rank(right.status) ||
      left.name.localeCompare(right.name)
    );
  });
  const checkCount = checks.length;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          expanded
            ? "resource.actions.collapseChecks"
            : "resource.actions.expandChecks",
        )}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>
          {expanded
            ? t("checksDetails.hideDetails")
            : t("checksDetails.showDetails", { count: checkCount })}
        </Text>
      </Pressable>
      {expanded ? (
        checks.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {t("checksDetails.noDetails")}
          </Text>
        ) : (
          checks.map((check) => (
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
                  fontWeight: "600",
                }}
              >
                {check.status === "failure"
                  ? t("checksDetails.failed")
                  : check.status === "pending"
                    ? t("checksDetails.pending")
                    : check.status === "unknown"
                      ? t("checksStatus.unknown")
                      : t("checksDetails.passed")}
              </Text>
              <Text style={{ color: theme.colors.foreground, flex: 1 }}>
                {check.name}
              </Text>
            </View>
          ))
        )
      ) : null}
    </View>
  );
}

function ResourceRow({
  item,
  theme,
  navigation,
  compact,
  onSelectLabel,
  onSelectMilestone,
  onFocusReference,
  onRefresh,
  refreshing,
  onEnsureWorkspace,
  ensuringWorkspace,
}: {
  item: IndexedResource;
  theme: PluginHostProps["theme"];
  navigation: WorkbenchProps["navigation"];
  compact: boolean;
  onSelectLabel: (label: string) => void;
  onSelectMilestone: (milestone: MilestoneFilter) => void;
  onFocusReference: (resource: GitHubResource) => void;
  onRefresh: (resource: GitHubResource) => void;
  refreshing: boolean;
  onEnsureWorkspace: (resource: GitHubResource) => void;
  ensuringWorkspace: boolean;
}) {
  const { resource, referencedTargets } = item;
  const { t } = useTranslation();
  const toast = useToast();
  const primaryAgent = resource.agents[0];
  const openExternal = useCallback(async () => {
    if (!(await openExternalUrl(resource.url, { linking: Linking })))
      toast.error(
        t("resource.errors.unableToOpenExternal", {
          repository: resource.repository,
          number: resource.number,
        }),
      );
  }, [resource, t, toast]);

  const kindLabel =
    resource.kind === "pull-request"
      ? t("resource.kind.pullRequest")
      : t("resource.kind.issue");
  const relationshipBadges = [
    resource.isMine ? t("resource.badges.yours") : null,
    resource.kind === "pull-request" && resource.reviewRequestedFromMe
      ? t("resource.badges.review")
      : null,
    resource.isAssignedToMe ? t("resource.badges.assigned") : null,
  ].filter(Boolean);
  const resourcePill = {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  } as const;
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: compact ? 10 : 12,
        gap: compact ? 8 : 10,
        padding: compact ? 10 : 14,
      }}
    >
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <View
          style={{
            backgroundColor: theme.colors.surface0,
            borderColor: theme.colors.border,
            borderRadius: 6,
            borderWidth: 1,
            paddingHorizontal: 7,
            paddingVertical: 3,
          }}
        >
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              fontWeight: "700",
            }}
          >
            {kindLabel} #{resource.number}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
          }}
        >
          {/* Dimension 1: Core Lifecycle */}
          {resource.kind === "pull-request" && resource.isDraft ? (
            <View
              style={{
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.border,
                borderRadius: 999,
                borderWidth: 1,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {t("resource.badges.draft")}
              </Text>
            </View>
          ) : (
            <View
              style={{
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.statusSuccess,
                borderRadius: 999,
                borderWidth: 1,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text
                style={{
                  color: theme.colors.statusSuccess,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {t("resource.badges.open")}
              </Text>
            </View>
          )}

          {/* Dimension 2: CI Checks (PRs only) */}
          {resource.kind === "pull-request" &&
          resource.checksStatus !== "none" ? (
            <View
              style={{
                backgroundColor: theme.colors.surface0,
                borderColor:
                  resource.checksStatus === "failure"
                    ? theme.colors.statusDanger
                    : resource.checksStatus === "pending"
                      ? theme.colors.statusWarning
                      : resource.checksStatus === "success"
                        ? theme.colors.statusSuccess
                        : theme.colors.border,
                borderRadius: 999,
                borderWidth: 1,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text
                style={{
                  color:
                    resource.checksStatus === "failure"
                      ? theme.colors.statusDanger
                      : resource.checksStatus === "pending"
                        ? theme.colors.statusWarning
                        : resource.checksStatus === "success"
                          ? theme.colors.statusSuccess
                          : theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {resource.checksStatus === "success"
                  ? t("resource.badges.ciPassing")
                  : resource.checksStatus === "pending"
                    ? t("resource.badges.ciRunning")
                    : resource.checksStatus === "failure"
                      ? t("resource.badges.ciFailing")
                      : t("checksStatus.unknown")}
              </Text>
            </View>
          ) : null}

          {/* Dimension 3: Review Decision (PRs only) */}
          {resource.kind === "pull-request" ? (
            resource.reviewDecision === "approved" ? (
              <View
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.statusSuccess,
                  borderRadius: 999,
                  borderWidth: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.statusSuccess,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {t("resource.badges.approved")}
                </Text>
              </View>
            ) : resource.reviewDecision === "changes_requested" ? (
              <View
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.statusDanger,
                  borderRadius: 999,
                  borderWidth: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.statusDanger,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {t("resource.badges.changesRequested")}
                </Text>
              </View>
            ) : resource.reviewDecision === "pending" ? (
              <View
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.statusWarning,
                  borderRadius: 999,
                  borderWidth: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.statusWarning,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {t("resource.badges.reviewRequired")}
                </Text>
              </View>
            ) : (
              <View
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                  borderRadius: 999,
                  borderWidth: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {t("resource.badges.unreviewed")}
                </Text>
              </View>
            )
          ) : null}

          {/* Dimension 4: Agent Status */}
          {primaryAgent ? (
            <View
              style={{
                backgroundColor: theme.colors.surface0,
                borderColor:
                  primaryAgent.status === "error" ||
                  primaryAgent.pendingPermissions > 0 ||
                  (primaryAgent.requiresAttention &&
                    primaryAgent.attentionReason !== "finished")
                    ? theme.colors.statusDanger
                    : theme.colors.statusWarning,
                borderRadius: 999,
                borderWidth: 1,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text
                style={{
                  color:
                    primaryAgent.status === "error" ||
                    primaryAgent.pendingPermissions > 0 ||
                    (primaryAgent.requiresAttention &&
                      primaryAgent.attentionReason !== "finished")
                      ? theme.colors.statusDanger
                      : theme.colors.statusWarning,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {primaryAgent.status === "error" ||
                primaryAgent.pendingPermissions > 0 ||
                (primaryAgent.requiresAttention &&
                  primaryAgent.attentionReason !== "finished")
                  ? t("resource.badges.agentAttention")
                  : t("resource.badges.agentWorking")}
              </Text>
            </View>
          ) : null}

          {/* Dimension 5: Merge Conflicts */}
          {resource.kind === "pull-request" &&
          resource.mergeable === "CONFLICTING" ? (
            <View
              style={{
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.statusDanger,
                borderRadius: 999,
                borderWidth: 1,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text
                style={{
                  color: theme.colors.statusDanger,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {t("resource.badges.conflicting")}
              </Text>
            </View>
          ) : null}
        </View>
        <Text
          accessible
          accessibilityRole="header"
          accessibilityLabel={t("resource.actions.resourceLabel", {
            kind: kindLabel,
            repository: resource.repository,
            number: resource.number,
            title: resource.title,
          })}
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            flex: 1,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {resource.repository}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            refreshing
              ? t("resource.actions.refreshingItem")
              : t("resource.actions.refreshItem")
          }
          accessibilityState={{ disabled: refreshing }}
          disabled={refreshing}
          onPress={() => onRefresh(resource)}
          style={{
            alignItems: "center",
            backgroundColor: theme.colors.surface0,
            borderColor: theme.colors.border,
            borderRadius: 999,
            borderWidth: 1,
            height: 28,
            justifyContent: "center",
            opacity: refreshing ? 0.6 : 1,
            width: 28,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color: theme.colors.accent,
              fontSize: 17,
              fontWeight: "700",
            }}
          >
            ↻
          </Text>
        </Pressable>
      </View>
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: compact ? 16 : 18,
          fontWeight: "700",
          lineHeight: compact ? 21 : 24,
        }}
      >
        {resource.title}
      </Text>
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {t("resource.meta.commentsCount", { count: resource.commentCount })}
        </Text>
        {resource.kind === "issue" && resource.milestoneTitle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.actions.selectMilestone", {
              milestone: resource.milestoneTitle,
            })}
            onPress={() => {
              const title = resource.milestoneTitle;
              if (title) onSelectMilestone({ kind: "named", title });
            }}
            style={resourcePill}
          >
            <Text
              style={{
                color: theme.colors.accent,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {resource.milestoneTitle}
            </Text>
          </Pressable>
        ) : null}
        {relationshipBadges.map((badge) => (
          <View key={badge} style={resourcePill}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "700",
              }}
            >
              {badge}
            </Text>
          </View>
        ))}
        {resource.labels.map((label) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.actions.selectLabel", { label })}
            key={label}
            onPress={() => onSelectLabel(label)}
            style={resourcePill}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {label}
            </Text>
          </Pressable>
        ))}
        {referencedTargets.map((target) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.relationships.focusResource", {
              number: target.number,
            })}
            key={target.key}
            onPress={() => onFocusReference(target)}
            style={resourcePill}
          >
            <Text
              style={{
                color: theme.colors.accent,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {t("resource.meta.linkedReference", { number: target.number })}
            </Text>
          </Pressable>
        ))}
      </View>
      {resource.kind === "pull-request" ? (
        <PullRequestChecks resource={resource} theme={theme} />
      ) : null}
      {primaryAgent ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {t("resource.meta.agentSummary", {
            title: primaryAgent.title ?? primaryAgent.id,
          })}
          {resource.agents.length > 1
            ? t("resource.meta.moreAgents", {
                count: resource.agents.length - 1,
              })
            : ""}
        </Text>
      ) : null}
      <View
        style={{
          alignItems: "center",
          borderColor: theme.colors.border,
          borderTopWidth: 1,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingTop: compact ? 8 : 10,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            ensuringWorkspace
              ? t("resource.actions.creatingWorkspace")
              : resource.workspaceIds[0]
                ? t("resource.actions.openWorkspace")
                : t("resource.actions.createWorkspace")
          }
          accessibilityState={{ disabled: ensuringWorkspace }}
          disabled={ensuringWorkspace}
          onPress={() => onEnsureWorkspace(resource)}
          style={{
            backgroundColor: theme.colors.accent,
            borderRadius: 8,
            opacity: ensuringWorkspace ? 0.6 : 1,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.colors.surface0, fontWeight: "700" }}
          >
            {ensuringWorkspace
              ? t("resource.actions.creatingWorkspace")
              : resource.workspaceIds[0]
                ? t("resource.actions.openWorkspace")
                : t("resource.actions.createWorkspace")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("resource.actions.openOnGitHub")}
          onPress={openExternal}
          style={{
            backgroundColor: theme.colors.surface0,
            borderColor: theme.colors.border,
            borderRadius: 8,
            borderWidth: 1,
            paddingHorizontal: 10,
            paddingVertical: 7,
          }}
        >
          <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>
            {t("resource.actions.openOnGitHub")}
          </Text>
        </Pressable>
        {primaryAgent && navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.actions.openAgent")}
            onPress={() => navigation.openAgent({ agentId: primaryAgent.id })}
            style={{
              backgroundColor: theme.colors.surface0,
              borderColor: theme.colors.border,
              borderRadius: 8,
              borderWidth: 1,
              paddingHorizontal: 10,
              paddingVertical: 7,
            }}
          >
            <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>
              {t("resource.actions.openAgent")}
            </Text>
          </Pressable>
        ) : null}
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
  showDiagnostics = true,
}: WorkbenchProps) {
  const { t } = useTranslation();
  const listResources = useRpc(listResourcesRpc);
  const queryClient = useQueryClient();
  const [quickFilter, setQuickFilter] = useState<QuickResourceFilter>(null);
  const [resourceKind, setResourceKind] = useState<ResourceKind | "all">("all");
  const [sort, setSort] = useState<ResourceSortDimension>("updated");
  const [sortDirection, setSortDirection] =
    useState<ResourceSortDirection>("desc");
  const [bucket, setBucket] = useState("all");
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [milestone, setMilestone] = useState<MilestoneFilter>(null);
  const [search, setSearch] = useState("");
  const [activeFocus, setActiveFocus] = useState<string | null>(null);
  const directory = usePaseoDirectory(host.id);
  const query = useQuery({
    queryKey: [
      "github-workbench",
      host.id,
      scope?.scope,
      scope?.scope === "repository" ? scope.repository : null,
    ],
    queryFn: () =>
      listResources(
        scope?.scope === "repository"
          ? { scope: "repository", repository: scope.repository }
          : { scope: "account" },
      ),
    enabled: Boolean(scope),
    refetchInterval: 60_000,
  });
  const index = useMemo(
    () => createResourceIndex(query.data?.resources ?? [], directory.data),
    [directory.data, query.data?.resources],
  );
  const queryResult = useMemo(
    () =>
      index.query({
        focusKey: activeFocus,
        quickFilter,
        kind: resourceKind,
        bucket: bucket as ResourceClassification["bucket"] | "all",
        label: activeLabel,
        milestone,
        search,
        sort,
        direction: sortDirection,
      }),
    [
      activeFocus,
      activeLabel,
      bucket,
      index,
      milestone,
      quickFilter,
      resourceKind,
      search,
      sort,
      sortDirection,
    ],
  );
  const filtered = queryResult.items;
  const summary = queryResult.summary;
  const mineCount = index.stats.mineCount;
  const draftsCount = index.stats.draftsCount;
  const milestoneOptions = index.stats.milestoneOptions;
  const clearFilters = useCallback(() => {
    setQuickFilter(null);
    setResourceKind("all");
    setBucket("all");
    setActiveLabel(null);
    setMilestone(null);
    setSearch("");
  }, []);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const toast = useToast();
  const refreshResource = useRpc(refreshResourceRpc);
  const ensureResourceWorkspace = useRpc(ensureResourceWorkspaceRpc);
  const ensureWorkspaceMutation = useMutation({
    mutationFn: ensureResourceWorkspace,
  });
  const [pendingWorkspaceCounts, setPendingWorkspaceCounts] = useState(
    () => new Map<string, number>(),
  );
  const ensureWorkspace = useCallback(
    (resource: GitHubResource) => {
      setPendingWorkspaceCounts((counts) =>
        adjustPendingResourceCount(counts, resource.key, 1),
      );
      ensureWorkspaceMutation.mutate(
        {
          kind: resource.kind,
          repository: resource.repository,
          number: resource.number,
          title: resource.title,
        },
        {
          onSuccess: (result) => {
            setPendingWorkspaceCounts((counts) =>
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
          },
          onError: (error) => {
            setPendingWorkspaceCounts((counts) =>
              adjustPendingResourceCount(counts, resource.key, -1),
            );
            toast.error(
              error instanceof Error
                ? error.message
                : t("resource.errors.ensureWorkspaceFailed"),
            );
          },
        },
      );
    },
    [ensureWorkspaceMutation, host.id, navigation, queryClient, t, toast],
  );
  const refreshMutation = useMutation({ mutationFn: refreshResource });
  const refreshItem = useCallback(
    (resource: GitHubResource) => {
      setRefreshingKey(resource.key);
      refreshMutation.mutate(
        {
          kind: resource.kind,
          repository: resource.repository,
          number: resource.number,
        },
        {
          onSuccess: ({ resource: refreshed }) => {
            queryClient.setQueryData(
              [
                "github-workbench",
                host.id,
                scope?.scope,
                scope?.scope === "repository" ? scope.repository : null,
              ],
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
            setRefreshingKey(null);
            toast.show(
              t("resource.toasts.refreshedItem", {
                repository: resource.repository,
                number: resource.number,
              }),
              { variant: "success" },
            );
          },
          onError: () => {
            setRefreshingKey(null);
            toast.error(t("resource.toasts.refreshFailed"));
          },
        },
      );
    },
    [host.id, queryClient, refreshMutation, scope, t, toast.error, toast.show],
  );
  const refresh = useCallback(() => {
    if (!scope) return;
    queryClient
      .fetchQuery({
        queryKey: [
          "github-workbench",
          host.id,
          scope.scope,
          scope.scope === "repository" ? scope.repository : null,
          "forced",
        ],
        queryFn: () =>
          listResources(
            scope.scope === "repository"
              ? {
                  scope: "repository",
                  repository: scope.repository,
                  forceRefresh: true,
                }
              : { scope: "account", forceRefresh: true },
          ),
      })
      .then(() => query.refetch())
      .catch(() => undefined);
  }, [host.id, listResources, query, queryClient, scope]);
  const styles = useMemo(
    () => ({
      screen: {
        backgroundColor: theme.colors.surface0,
        flex: 1,
        gap: layout.compact ? 10 : 14,
        padding: layout.compact ? 12 : 20,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "700" as const,
      },
      muted: { color: theme.colors.foregroundMuted },
      panel: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: layout.compact ? 10 : 12,
        borderWidth: 1,
        gap: layout.compact ? 8 : 10,
        padding: layout.compact ? 10 : 12,
      },
      toolbarRow: {
        alignItems: "center" as const,
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: layout.compact ? 6 : 8,
      },
      chip: {
        borderColor: theme.colors.border,
        borderRadius: 999,
        borderWidth: 1,
        paddingHorizontal: 9,
        paddingVertical: layout.compact ? 5 : 6,
      },
      activeChip: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      input: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        color: theme.colors.foreground,
        flex: 1,
        minWidth: layout.compact ? 150 : 220,
        padding: layout.compact ? 8 : 10,
      },
      action: {
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 7,
      },
      primaryAction: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
    }),
    [layout.compact, theme],
  );

  const kindOptions = useMemo<
    Array<{ key: ResourceKind | "all"; label: string }>
  >(
    () => [
      { key: "all", label: t("filters.kinds.all") },
      { key: "pull-request", label: t("filters.kinds.pullRequest") },
      { key: "issue", label: t("filters.kinds.issue") },
    ],
    [t],
  );

  const bucketOptions = useMemo<
    Array<{
      key: "all" | ResourceClassification["bucket"];
      label: string;
    }>
  >(
    () => [
      { key: "all", label: t("filters.buckets.all") },
      { key: "needs-attention", label: t("filters.buckets.needsAttention") },
      { key: "being-handled", label: t("filters.buckets.beingHandled") },
      { key: "waiting", label: t("filters.buckets.waiting") },
      { key: "ready", label: t("filters.buckets.ready") },
      { key: "open", label: t("filters.buckets.open") },
    ],
    [t],
  );

  if (!scope)
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>{t("workbench.noScopeDescription")}</Text>
      </View>
    );

  const compactDiagnostics = showDiagnostics ? (
    <GitHubDiagnosticsStatus
      compact={layout.compact}
      hostId={host.id}
      theme={theme}
    />
  ) : null;

  return (
    <View style={styles.screen}>
      {compactDiagnostics ? (
        <View style={{ alignItems: "flex-end" }}>{compactDiagnostics}</View>
      ) : null}
      {activeFocus ? (
        <View style={styles.toolbarRow}>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.colors.foreground, fontWeight: "600" }}
          >
            {t("resource.relationships.activeFocus", {
              number: index.get(activeFocus)?.number ?? activeFocus,
            })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("resource.relationships.clearFocus")}
            onPress={() => setActiveFocus(null)}
            style={[styles.action, styles.primaryAction]}
          >
            <Text style={{ color: theme.colors.surface0, fontWeight: "700" }}>
              {t("resource.relationships.clearFocus")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.panel}>
        <View style={styles.toolbarRow}>
          <TextInput
            accessibilityLabel={t("workbench.searchAriaLabel")}
            value={search}
            onChangeText={setSearch}
            placeholder={t("workbench.searchPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workbench.refresh")}
            onPress={refresh}
            style={[styles.action, styles.primaryAction]}
          >
            <Text style={{ color: theme.colors.surface0, fontWeight: "700" }}>
              {t("workbench.refresh")}
            </Text>
          </Pressable>
          <ToolbarGroup>
            {kindOptions.map((item) => (
              <FilterChip
                key={item.key}
                label={item.label}
                onPress={() => setResourceKind(item.key)}
                selected={resourceKind === item.key}
                styles={styles}
                theme={theme}
              />
            ))}
          </ToolbarGroup>
          <ToolbarGroup>
            {(["mine", "drafts"] as const).map((item) => {
              const count = item === "mine" ? mineCount : draftsCount;
              const label =
                item === "mine"
                  ? t("filters.mineWithCount", { count })
                  : t("filters.draftsWithCount", { count });
              return (
                <FilterChip
                  key={item}
                  label={label}
                  onPress={() =>
                    setQuickFilter(quickFilter === item ? null : item)
                  }
                  selected={quickFilter === item}
                  styles={styles}
                  theme={theme}
                />
              );
            })}
          </ToolbarGroup>
        </View>
        <View style={styles.toolbarRow}>
          <ToolbarGroup>
            {bucketOptions.map((item) => (
              <FilterChip
                key={item.key}
                label={item.label}
                onPress={() => setBucket(item.key)}
                selected={bucket === item.key}
                styles={styles}
                theme={theme}
              />
            ))}
          </ToolbarGroup>
          <View
            style={{
              backgroundColor: theme.colors.border,
              height: 16,
              marginHorizontal: 4,
              width: 1,
            }}
          />
          {milestoneOptions.length > 0 ? (
            <ToolbarGroup>
              <FilterChip
                label={t("filters.noMilestone")}
                onPress={() => setMilestone({ kind: "none" })}
                selected={milestone?.kind === "none"}
                styles={styles}
                theme={theme}
              />
              {milestoneOptions.map((item) => (
                <FilterChip
                  key={item}
                  label={item}
                  onPress={() => setMilestone({ kind: "named", title: item })}
                  selected={
                    milestone?.kind === "named" && milestone.title === item
                  }
                  styles={styles}
                  theme={theme}
                />
              ))}
            </ToolbarGroup>
          ) : null}
          {activeLabel ? (
            <FilterChip
              label={`${t("filters.activeLabel", { label: activeLabel })} ×`}
              onPress={() => setActiveLabel(null)}
              selected
              styles={styles}
              theme={theme}
            />
          ) : null}
          {milestone ? (
            <FilterChip
              label={`${milestone.kind === "none" ? t("filters.noMilestone") : t("filters.activeMilestone", { milestone: milestone.title })} ×`}
              onPress={() => setMilestone(null)}
              selected
              styles={styles}
              theme={theme}
            />
          ) : null}
          <ToolbarGroup>
            {(["updated", "priority", "created", "comments"] as const).map(
              (item) => (
                <FilterChip
                  key={item}
                  label={t(`sort.${item}`)}
                  onPress={() => setSort(item)}
                  selected={sort === item}
                  styles={styles}
                  theme={theme}
                />
              ),
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                sortDirection === "asc"
                  ? t("sort.directionAsc")
                  : t("sort.directionDesc")
              }
              onPress={() =>
                setSortDirection((value) => (value === "asc" ? "desc" : "asc"))
              }
              style={styles.action}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {sortDirection === "asc" ? "↑" : "↓"}{" "}
                {sortDirection === "asc"
                  ? t("sort.directionAsc")
                  : t("sort.directionDesc")}
              </Text>
            </Pressable>
          </ToolbarGroup>
          <View
            style={{
              alignItems: "center",
              flexDirection: "row",
              flexGrow: 1,
              flexWrap: "wrap",
              gap: 6,
              justifyContent: "flex-end",
            }}
          >
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              {t("summary.total", { count: summary.total })}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t("summary.pullRequests", { count: summary.pullRequests })}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t("summary.issues", { count: summary.issues })}
            </Text>
            {summary.needsAttention ? (
              <Text
                style={{
                  color: theme.colors.statusDanger,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {t("summary.needsAttention", { count: summary.needsAttention })}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
      {query.data?.warnings.map((warning) => (
        <Text key={warning.code} style={{ color: theme.colors.statusWarning }}>
          {warning.message}
        </Text>
      ))}
      {query.isLoading || directory.isLoading ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {t("workbench.loading")}
        </Text>
      ) : null}
      {query.error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.statusDanger }}
        >
          {query.error instanceof Error
            ? query.error.message
            : t("workbench.unableToLoad")}
        </Text>
      ) : null}
      <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 24 }}>
        {filtered.map((item) => (
          <ResourceRow
            key={item.resource.key}
            item={item}
            theme={theme}
            navigation={navigation}
            compact={layout.compact}
            onSelectLabel={setActiveLabel}
            onSelectMilestone={setMilestone}
            onFocusReference={(target) => setActiveFocus(target.key)}
            onRefresh={refreshItem}
            refreshing={refreshingKey === item.resource.key}
            onEnsureWorkspace={ensureWorkspace}
            ensuringWorkspace={
              (pendingWorkspaceCounts.get(item.resource.key) ?? 0) > 0
            }
          />
        ))}
        {!query.isLoading && filtered.length === 0 ? (
          <View style={{ alignItems: "center", gap: 10, paddingVertical: 24 }}>
            <Text style={styles.muted}>{t("workbench.empty")}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("filters.clearAll")}
              onPress={clearFilters}
              style={[styles.action, styles.primaryAction]}
            >
              <Text style={{ color: theme.colors.surface0, fontWeight: "700" }}>
                {t("filters.clearAll")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function useProjectRepositories(
  projectId: string | null,
  hostId: string,
) {
  const directory = usePaseoDirectory(hostId);
  return useMemo(
    () => [
      ...new Set(
        (directory.data?.workspaces ?? [])
          .filter(
            (workspace) =>
              !workspace.archivingAt &&
              (projectId === null || workspace.projectId === projectId),
          )
          .flatMap((workspace) => {
            const repository = normalizeGitHubRepository(workspace.remoteUrl);
            return repository ? [repository] : [];
          }),
      ),
    ],
    [directory.data?.workspaces, projectId],
  );
}

import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const ResourceKindSchema = z.enum(["pull-request", "issue"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const LifecycleStateSchema = z.enum(["open", "merged", "closed"]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export const ChecksStatusSchema = z.enum([
  "success",
  "pending",
  "failure",
  "none",
  "unknown",
]);
export type ChecksStatus = z.infer<typeof ChecksStatusSchema>;

export const AgentSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
  pendingPermissions: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

const ResourceBaseSchema = z.object({
  key: z.string(),
  kind: ResourceKindSchema,
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(""),
  url: z.string().url(),
  authorLogin: z.string().nullable(),
  assigneeLogins: z.array(z.string()),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable().default(null),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]).default("OPEN"),
  lifecycleState: LifecycleStateSchema.default("open"),
  isMine: z.boolean(),
  isAssignedToMe: z.boolean(),
  workspaceIds: z.array(z.string()),
  workspaceNames: z.array(z.string()),
  agents: z.array(AgentSummarySchema),
});

export const PullRequestCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["success", "failure", "pending", "unknown"]),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheckSchema>;

export const PullRequestResourceSchema = ResourceBaseSchema.extend({
  kind: z.literal("pull-request"),
  isDraft: z.boolean(),
  headRefName: z.string().nullable(),
  baseRefName: z.string().nullable(),
  mergedAt: z.string().nullable().default(null),
  checksStatus: ChecksStatusSchema,
  checkDetails: z.array(PullRequestCheckSchema).default([]),
  commentCount: z.number().int().nonnegative(),
  reviewDecision: z.enum([
    "approved",
    "changes_requested",
    "pending",
    "unknown",
  ]),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewRequestedFromMe: z.boolean(),
});
export const IssueResourceSchema = ResourceBaseSchema.extend({
  kind: z.literal("issue"),
  milestoneTitle: z.string().nullable(),
  commentCount: z.number().int().nonnegative(),
});

export const GitHubResourceSchema = z.discriminatedUnion("kind", [
  PullRequestResourceSchema,
  IssueResourceSchema,
]);
export type GitHubResource = z.infer<typeof GitHubResourceSchema>;
export type PullRequestResource = z.infer<typeof PullRequestResourceSchema>;
export type IssueResource = z.infer<typeof IssueResourceSchema>;

export const WarningSchema = z.object({
  code: z.enum([
    "gh-cli-not-found",
    "gh-not-authenticated",
    "github-rate-limited",
    "repository-unavailable",
    "github-query-failed",
  ]),
  message: z.string(),
});

export const listResourcesRpc = defineRpc({
  name: "github-workbench.list-resources",
  input: z
    .object({
      scope: z.enum(["account", "repository"]),
      repository: z
        .string()
        .regex(/^[^/\s]+\/[^/\s]+$/)
        .optional(),
      state: LifecycleStateSchema.default("open").optional(),
      forceRefresh: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (value.scope === "repository" && !value.repository) {
        context.addIssue({
          code: "custom",
          message: "repository scope requires repository",
          path: ["repository"],
        });
      }
    }),
  output: z.object({
    resources: z.array(GitHubResourceSchema),
    refreshedAt: z.string(),
    warnings: z.array(WarningSchema),
  }),
});

export const refreshResourceRpc = defineRpc({
  name: "github-workbench.refresh-resource",
  input: z.object({
    kind: ResourceKindSchema,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    number: z.number().int().positive(),
  }),
  output: z.object({ resource: GitHubResourceSchema }),
});

export const ProjectCatalogItemSchema = z.object({
  projectId: z.string(),
  displayName: z.string(),
  projectRootPath: z.string(),
  repository: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .nullable(),
});

export type ProjectCatalogItem = z.infer<typeof ProjectCatalogItemSchema>;
export const listProjectCatalogRpc = defineRpc({
  name: "github-workbench.list-project-catalog",
  input: z.object({ forceRefresh: z.boolean().optional() }),
  output: z.object({ projects: z.array(ProjectCatalogItemSchema) }),
});

export const ensureResourceWorkspaceRpc = defineRpc({
  name: "github-workbench.ensure-resource-workspace",
  input: z.object({
    kind: ResourceKindSchema,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    number: z.number().int().positive(),
    title: z.string().min(1).max(500),
  }),
  output: z.object({
    action: z.enum([
      "opened",
      "created",
      "local-project-not-found",
      "base-branch-unavailable",
    ]),
    workspaceId: z.string().optional(),
    message: z.string(),
  }),
});

export function resourceKey(
  kind: ResourceKind,
  repository: string,
  number: number,
): string {
  return `${kind}:${repository.toLowerCase()}#${number}`;
}

export function normalizeGitHubRepository(
  remoteUrl: string | null | undefined,
): string | null {
  if (!remoteUrl) return null;
  const value = remoteUrl.trim().replace(/\.git$/i, "");
  const https = value.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = value.match(
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+)$/i,
  );
  return ssh ? `${ssh[1]}/${ssh[2]}` : null;
}

export type ResourceWorkspaceCandidate = {
  remoteUrl: string | null;
  pullRequestNumber?: number;
  worktreeSlug?: string | null;
  archivingAt: string | null;
};

export function resourceMatchesWorkspace(
  resource: Pick<GitHubResource, "kind" | "repository" | "number">,
  workspace: ResourceWorkspaceCandidate,
): boolean {
  if (workspace.archivingAt) return false;
  if (
    normalizeGitHubRepository(workspace.remoteUrl)?.toLowerCase() !==
    resource.repository.toLowerCase()
  )
    return false;
  return resource.kind === "pull-request"
    ? workspace.pullRequestNumber === resource.number ||
        workspace.worktreeSlug === `pr-${resource.number}`
    : (workspace.worktreeSlug?.startsWith(`issue-${resource.number}-`) ??
        false);
}

export function adjustPendingResourceCount(
  counts: ReadonlyMap<string, number>,
  resourceKey: string,
  change: 1 | -1,
): Map<string, number> {
  const next = new Map(counts);
  const count = (next.get(resourceKey) ?? 0) + change;
  if (count > 0) next.set(resourceKey, count);
  else next.delete(resourceKey);
  return next;
}

type UrlOpener = (url: string) => unknown;

type DesktopUrlOpener = {
  openUrl: UrlOpener;
};

type PaseoDesktopBridge = {
  opener?: DesktopUrlOpener;
};

declare global {
  var paseoDesktop: PaseoDesktopBridge | undefined;
}

type ExternalUrlDependencies = {
  linking: {
    openURL: UrlOpener;
  };
  desktopOpener?: DesktopUrlOpener;
};

export async function openExternalUrl(
  url: string,
  {
    linking,
    desktopOpener = globalThis.paseoDesktop?.opener,
  }: ExternalUrlDependencies,
): Promise<boolean> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
    return false;
  if (desktopOpener) {
    try {
      if ((await desktopOpener.openUrl(url)) !== false) return true;
    } catch {
      // Fall back to React Native Linking when the desktop bridge cannot open.
    }
  }
  try {
    return (await linking.openURL(url)) !== false;
  } catch {
    return false;
  }
}

export function mergeRefreshedResource(
  current: GitHubResource,
  refreshed: GitHubResource,
): GitHubResource {
  return {
    ...current,
    ...refreshed,
    isMine: current.isMine,
    isAssignedToMe: current.isAssignedToMe,
    workspaceIds: current.workspaceIds,
    workspaceNames: current.workspaceNames,
    agents: current.agents,
    ...(current.kind === "pull-request" && refreshed.kind === "pull-request"
      ? { reviewRequestedFromMe: current.reviewRequestedFromMe }
      : {}),
  };
}

/**
 * Adds fields that are only requested by the on-demand detail query while
 * keeping the list summary authoritative for all shared fields.
 */
export function mergeDetailedResource(
  summary: GitHubResource,
  detail: GitHubResource,
): GitHubResource {
  if (summary.key !== detail.key || summary.kind !== detail.kind)
    return summary;
  if (summary.kind === "pull-request" && detail.kind === "pull-request") {
    return {
      ...summary,
      body: detail.body,
      checkDetails: detail.checkDetails,
    };
  }
  return { ...summary, body: detail.body };
}

export function isGitHubResourceDetailStale(
  summary: GitHubResource,
  detail: GitHubResource,
): boolean {
  if (summary.key !== detail.key || summary.kind !== detail.kind) return true;
  if (detail.updatedAt < summary.updatedAt) return true;
  if (detail.updatedAt > summary.updatedAt) return false;
  return summary.kind === "pull-request" && detail.kind === "pull-request"
    ? detail.checksStatus !== summary.checksStatus
    : false;
}

export function issueBranchSlug(number: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `issue-${number}-${slug}`;
}

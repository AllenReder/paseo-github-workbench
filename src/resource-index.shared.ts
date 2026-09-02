import type {
  AgentSummary,
  GitHubResource,
  IssueResource,
  PullRequestResource,
  ResourceKind,
} from "./github-workbench.shared";
import {
  normalizeGitHubRepository,
  resourceKey,
  resourceMatchesWorkspace,
} from "./github-workbench.shared";

export type WorkspaceSnapshot = {
  id: string;
  projectId: string;
  projectDisplayName: string;
  name: string;
  archivingAt: string | null;
  remoteUrl: string | null;
  pullRequestNumber?: number;
  worktreeSlug?: string | null;
  activityAt: string | null;
};

export type AgentSnapshot = {
  id: string;
  workspaceId?: string;
  title: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  pendingPermissions: number;
  updatedAt: string;
  labels: Record<string, string>;
};

export type PaseoDirectorySnapshot = {
  workspaces: WorkspaceSnapshot[];
  agents: AgentSnapshot[];
};

export type ResourceClassification = {
  bucket: "needs-attention" | "being-handled" | "waiting" | "ready" | "open";
  reason: string;
};

export type IndexedResource = {
  resource: GitHubResource;
  classification: ResourceClassification;
  referencedTargets: readonly GitHubResource[];
};

export type QuickResourceFilter = "mine" | "drafts" | null;

export type MilestoneFilter =
  | { kind: "named"; title: string }
  | { kind: "none" }
  | null;

export type ResourceSortDimension =
  | "updated"
  | "priority"
  | "created"
  | "comments";

export type ResourceSortDirection = "asc" | "desc";

export type ResourceSummary = {
  total: number;
  pullRequests: number;
  issues: number;
  needsAttention: number;
};

export type ResourceIndex = {
  readonly resources: readonly GitHubResource[];
  readonly stats: {
    mineCount: number;
    draftsCount: number;
    milestoneOptions: readonly string[];
  };
  get(key: string): GitHubResource | undefined;
  query(criteria: {
    focusKey: string | null;
    quickFilter: QuickResourceFilter;
    kind: ResourceKind | "all";
    bucket: ResourceClassification["bucket"] | "all";
    label: string | null;
    milestone: MilestoneFilter;
    search: string;
    sort: ResourceSortDimension;
    direction: ResourceSortDirection;
  }): {
    items: readonly IndexedResource[];
    summary: ResourceSummary;
  };
};

const RESOURCE_BUCKET_ORDER: Record<ResourceClassification["bucket"], number> =
  {
    "needs-attention": 0,
    "being-handled": 1,
    ready: 2,
    waiting: 3,
    open: 4,
  };

function activeAgent(
  agents: readonly AgentSummary[],
): AgentSummary | undefined {
  let best: AgentSummary | undefined;
  let bestRank = 4;
  for (const agent of agents) {
    let rank = 3;
    if (
      agent.pendingPermissions > 0 ||
      (agent.requiresAttention && agent.attentionReason !== "finished") ||
      agent.status === "error"
    ) {
      rank = 0;
    } else if (agent.status === "running" || agent.status === "initializing") {
      rank = 1;
    } else if (agent.status === "idle") {
      rank = 2;
    }
    if (rank < bestRank) {
      bestRank = rank;
      best = agent;
      if (bestRank === 0) break;
    }
  }
  return best;
}

function classifyPullRequest(
  resource: PullRequestResource,
): ResourceClassification {
  const agent = activeAgent(resource.agents);
  if (
    agent &&
    (agent.pendingPermissions > 0 ||
      (agent.requiresAttention && agent.attentionReason !== "finished"))
  )
    return { bucket: "needs-attention", reason: "Agent needs attention" };
  if (
    agent?.status === "error" &&
    !resource.agents.some(
      (item) => item.status === "running" || item.status === "initializing",
    )
  )
    return { bucket: "needs-attention", reason: "Agent failed" };
  if (
    resource.agents.some(
      (item) => item.status === "running" || item.status === "initializing",
    )
  )
    return { bucket: "being-handled", reason: "Agent is working" };
  if (resource.checksStatus === "pending")
    return { bucket: "waiting", reason: "Checks running" };
  if (resource.reviewRequestedFromMe)
    return { bucket: "needs-attention", reason: "Your review requested" };
  if (
    resource.isMine &&
    (resource.mergeable === "CONFLICTING" ||
      resource.checksStatus === "failure" ||
      resource.reviewDecision === "changes_requested")
  )
    return {
      bucket: "needs-attention",
      reason:
        resource.checksStatus === "failure"
          ? "Checks failing"
          : "Changes needed",
    };
  if (
    resource.isMine &&
    !resource.isDraft &&
    ["success", "none"].includes(resource.checksStatus)
  ) {
    if (resource.mergeable === "MERGEABLE") {
      if (resource.reviewDecision === "approved")
        return { bucket: "ready", reason: "Ready to merge" };
      return { bucket: "waiting", reason: "Waiting for review" };
    }
    return { bucket: "waiting", reason: "Waiting for mergeability" };
  }
  return { bucket: "waiting", reason: "Waiting for GitHub activity" };
}

function classifyIssue(resource: IssueResource): ResourceClassification {
  const agent = activeAgent(resource.agents);
  if (
    agent &&
    (agent.pendingPermissions > 0 ||
      (agent.requiresAttention && agent.attentionReason !== "finished") ||
      agent.status === "error")
  )
    return { bucket: "needs-attention", reason: "Agent needs attention" };
  if (
    resource.agents.some(
      (item) => item.status === "running" || item.status === "initializing",
    )
  )
    return { bucket: "being-handled", reason: "Agent is working" };
  return {
    bucket: "open",
    reason: resource.isAssignedToMe ? "Assigned to you" : "Open issue",
  };
}

function classifyResource(resource: GitHubResource): ResourceClassification {
  return resource.kind === "pull-request"
    ? classifyPullRequest(resource)
    : classifyIssue(resource);
}

function extractReferencedNumbers(resource: GitHubResource): number[] {
  const text = [
    resource.title,
    resource.kind === "pull-request" ? resource.headRefName : "",
  ].join(" ");
  return Array.from(text.matchAll(/#(\d+)/g), (match) =>
    Number(match[1]),
  ).filter(
    (number, index, numbers) =>
      Number.isInteger(number) && numbers.indexOf(number) === index,
  );
}

type InternalIndexed = {
  resource: GitHubResource;
  classification: ResourceClassification;
  searchCorpus: string;
  bucketRank: number;
};

export function createResourceIndex(
  inputResources: readonly GitHubResource[],
  directory?: PaseoDirectorySnapshot,
): ResourceIndex {
  // 1. Enrich resources with directory data if available
  const workspacesByRepo = new Map<string, WorkspaceSnapshot[]>();
  if (directory) {
    for (const ws of directory.workspaces) {
      if (ws.archivingAt) continue;
      const repo = normalizeGitHubRepository(ws.remoteUrl)?.toLowerCase();
      if (!repo) continue;
      let list = workspacesByRepo.get(repo);
      if (!list) {
        list = [];
        workspacesByRepo.set(repo, list);
      }
      list.push(ws);
    }
  }

  const enrichedResources: GitHubResource[] = inputResources.map((resource) => {
    if (!directory) return resource;
    const repoCandidateWorkspaces =
      workspacesByRepo.get(resource.repository.toLowerCase()) ?? [];
    const matchingWorkspaces = repoCandidateWorkspaces
      .filter((ws) => resourceMatchesWorkspace(resource, ws))
      .sort(
        (left, right) =>
          (right.activityAt ?? "").localeCompare(left.activityAt ?? "") ||
          left.id.localeCompare(right.id),
      );

    const resourceId = resourceKey(
      resource.kind,
      resource.repository,
      resource.number,
    );
    const matchingWorkspaceIdSet = new Set(
      matchingWorkspaces.map((ws) => ws.id),
    );

    const matchedAgents = directory.agents.filter(
      (agent) =>
        agent.labels["github-workbench.resource"] === resourceId ||
        (agent.workspaceId && matchingWorkspaceIdSet.has(agent.workspaceId)),
    );

    const agentSummaries: AgentSummary[] = [];
    const seenAgentIds = new Set<string>();
    for (const agent of matchedAgents) {
      if (seenAgentIds.has(agent.id)) continue;
      seenAgentIds.add(agent.id);
      agentSummaries.push({
        id: agent.id,
        title: agent.title,
        status: agent.status,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
        pendingPermissions: agent.pendingPermissions,
        updatedAt: agent.updatedAt,
      });
    }

    return {
      ...resource,
      workspaceIds: matchingWorkspaces.map((ws) => ws.id),
      workspaceNames: matchingWorkspaces.map((ws) => ws.name),
      agents: agentSummaries,
    };
  });

  // 2. Build lookup maps and stats
  const resourcesByKey = new Map<string, GitHubResource>();
  const resourcesByRepoKindNumber = new Map<string, GitHubResource>();
  let mineCount = 0;
  let draftsCount = 0;
  const milestoneSet = new Set<string>();

  for (const res of enrichedResources) {
    resourcesByKey.set(res.key, res);
    const coordKey = `${res.repository.toLowerCase()}:${res.kind}:${res.number}`;
    resourcesByRepoKindNumber.set(coordKey, res);

    if (res.isMine) mineCount += 1;
    if (res.kind === "pull-request" && res.isDraft) draftsCount += 1;
    if (res.kind === "issue" && res.milestoneTitle) {
      milestoneSet.add(res.milestoneTitle);
    }
  }

  const milestoneOptions = Array.from(milestoneSet).sort((a, b) =>
    a.localeCompare(b),
  );

  // 3. Bidirectional cross-references
  const referenceTargetsByKey = new Map<string, GitHubResource[]>();
  for (const res of enrichedResources) {
    referenceTargetsByKey.set(res.key, []);
  }

  const seenEdges = new Set<string>();
  for (const source of enrichedResources) {
    const numbers = extractReferencedNumbers(source);
    const oppositeKind: ResourceKind =
      source.kind === "pull-request" ? "issue" : "pull-request";
    for (const num of numbers) {
      const targetCoordKey = `${source.repository.toLowerCase()}:${oppositeKind}:${num}`;
      const target = resourcesByRepoKindNumber.get(targetCoordKey);
      if (!target || target.key === source.key) continue;

      const edge1 = `${source.key}->${target.key}`;
      if (!seenEdges.has(edge1)) {
        seenEdges.add(edge1);
        referenceTargetsByKey.get(source.key)?.push(target);
      }
      const edge2 = `${target.key}->${source.key}`;
      if (!seenEdges.has(edge2)) {
        seenEdges.add(edge2);
        referenceTargetsByKey.get(target.key)?.push(source);
      }
    }
  }

  // 4. Precompute classification and search corpus
  const indexedList: InternalIndexed[] = enrichedResources.map((resource) => {
    const classification = classifyResource(resource);
    const searchCorpus = [
      resource.repository,
      resource.number,
      resource.title,
      resource.authorLogin,
      ...resource.labels,
      resource.kind === "issue"
        ? resource.milestoneTitle
        : resource.headRefName,
      ...resource.workspaceNames,
      ...resource.agents.map((agent) => agent.title),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return {
      resource,
      classification,
      searchCorpus,
      bucketRank: RESOURCE_BUCKET_ORDER[classification.bucket],
    };
  });

  const indexedByKey = new Map<string, InternalIndexed>();
  for (const item of indexedList) {
    indexedByKey.set(item.resource.key, item);
  }

  function get(key: string): GitHubResource | undefined {
    return resourcesByKey.get(key);
  }

  function query(criteria: {
    focusKey: string | null;
    quickFilter: QuickResourceFilter;
    kind: ResourceKind | "all";
    bucket: ResourceClassification["bucket"] | "all";
    label: string | null;
    milestone: MilestoneFilter;
    search: string;
    sort: ResourceSortDimension;
    direction: ResourceSortDirection;
  }): {
    items: readonly IndexedResource[];
    summary: ResourceSummary;
  } {
    if (criteria.focusKey !== null) {
      const item = indexedByKey.get(criteria.focusKey);
      if (!item) {
        return {
          items: [],
          summary: { total: 0, pullRequests: 0, issues: 0, needsAttention: 0 },
        };
      }
      const referencedTargets =
        referenceTargetsByKey.get(item.resource.key) ?? [];
      const single: IndexedResource = {
        resource: item.resource,
        classification: item.classification,
        referencedTargets,
      };
      const summary: ResourceSummary = {
        total: 1,
        pullRequests: item.resource.kind === "pull-request" ? 1 : 0,
        issues: item.resource.kind === "issue" ? 1 : 0,
        needsAttention:
          item.classification.bucket === "needs-attention" ? 1 : 0,
      };
      return { items: [single], summary };
    }

    const trimmedSearch = criteria.search.trim().toLowerCase();
    const filtered: InternalIndexed[] = [];

    for (const item of indexedList) {
      const res = item.resource;
      if (criteria.quickFilter === "mine" && !res.isMine) continue;
      if (
        criteria.quickFilter === "drafts" &&
        (res.kind !== "pull-request" || !res.isDraft)
      )
        continue;
      if (criteria.kind !== "all" && res.kind !== criteria.kind) continue;
      if (
        criteria.bucket !== "all" &&
        item.classification.bucket !== criteria.bucket
      )
        continue;
      if (criteria.label && !res.labels.includes(criteria.label)) continue;

      if (criteria.milestone) {
        if (res.kind !== "issue") continue;
        if (criteria.milestone.kind === "none" && res.milestoneTitle !== null)
          continue;
        if (
          criteria.milestone.kind === "named" &&
          res.milestoneTitle !== criteria.milestone.title
        )
          continue;
      }

      if (trimmedSearch && !item.searchCorpus.includes(trimmedSearch)) continue;

      filtered.push(item);
    }

    const sign = criteria.direction === "asc" ? 1 : -1;
    filtered.sort((left, right) => {
      let primary = 0;
      if (criteria.sort === "priority") {
        primary =
          (left.bucketRank - right.bucketRank ||
            right.resource.updatedAt.localeCompare(left.resource.updatedAt)) *
          sign;
      } else if (criteria.sort === "created") {
        primary =
          sign *
          left.resource.createdAt.localeCompare(right.resource.createdAt);
      } else if (criteria.sort === "comments") {
        primary =
          sign * (left.resource.commentCount - right.resource.commentCount);
      } else {
        primary =
          sign *
          left.resource.updatedAt.localeCompare(right.resource.updatedAt);
      }
      return (
        primary ||
        left.resource.repository.localeCompare(right.resource.repository) ||
        left.resource.number - right.resource.number
      );
    });

    let total = 0;
    let pullRequests = 0;
    let issues = 0;
    let needsAttention = 0;

    const items: IndexedResource[] = new Array(filtered.length);
    for (let i = 0; i < filtered.length; i += 1) {
      const item = filtered[i];
      total += 1;
      if (item.resource.kind === "pull-request") pullRequests += 1;
      else if (item.resource.kind === "issue") issues += 1;
      if (item.classification.bucket === "needs-attention") {
        needsAttention += 1;
      }

      items[i] = {
        resource: item.resource,
        classification: item.classification,
        referencedTargets: referenceTargetsByKey.get(item.resource.key) ?? [],
      };
    }

    return {
      items,
      summary: { total, pullRequests, issues, needsAttention },
    };
  }

  return {
    resources: enrichedResources,
    stats: {
      mineCount,
      draftsCount,
      milestoneOptions,
    },
    get,
    query,
  };
}

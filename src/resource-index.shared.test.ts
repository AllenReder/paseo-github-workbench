import { describe, expect, it } from "bun:test";
import type {
  IssueResource,
  PullRequestResource,
} from "./github-workbench.shared";
import {
  applyAgentUpdate,
  applyWorkspaceUpdate,
  createResourceIndex,
} from "./resource-index.shared";

describe("ResourceIndex", () => {
  const pr1: PullRequestResource = {
    key: "pull-request:getpaseo/paseo#10",
    kind: "pull-request",
    repository: "getpaseo/paseo",
    number: 10,
    title: "Fix bug #20 in parser",
    body: "Fix description",
    url: "https://github.com/getpaseo/paseo/pull/10",
    authorLogin: "alice",
    assigneeLogins: [],
    labels: ["bug", "frontend"],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-03T00:00:00Z",
    isMine: true,
    isAssignedToMe: false,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    isDraft: false,
    headRefName: "fix-20",
    baseRefName: "main",
    closedAt: null,
    mergedAt: null,
    state: "OPEN",
    lifecycleState: "open",
    checksStatus: "success",
    checkDetails: [],
    commentCount: 3,
    reviewDecision: "approved",
    mergeable: "MERGEABLE",
    reviewRequestedFromMe: false,
  };

  const prDraft: PullRequestResource = {
    key: "pull-request:getpaseo/paseo#12",
    kind: "pull-request",
    repository: "getpaseo/paseo",
    number: 12,
    title: "WIP feature",
    body: "Draft description",
    url: "https://github.com/getpaseo/paseo/pull/12",
    authorLogin: "alice",
    assigneeLogins: [],
    labels: [],
    createdAt: "2026-02-02T00:00:00Z",
    updatedAt: "2026-02-02T00:00:00Z",
    isMine: true,
    isAssignedToMe: false,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    isDraft: true,
    headRefName: "wip",
    baseRefName: "main",
    closedAt: null,
    mergedAt: null,
    state: "OPEN",
    lifecycleState: "open",
    checksStatus: "none",
    checkDetails: [],
    commentCount: 0,
    reviewDecision: "unknown",
    mergeable: "UNKNOWN",
    reviewRequestedFromMe: false,
  };

  const issue1: IssueResource = {
    key: "issue:getpaseo/paseo#20",
    kind: "issue",
    repository: "getpaseo/paseo",
    number: 20,
    title: "Parser crashes on null",
    body: "Issue description",
    url: "https://github.com/getpaseo/paseo/issues/20",
    authorLogin: "bob",
    assigneeLogins: ["charlie"],
    labels: ["bug"],
    createdAt: "2026-01-15T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    isMine: false,
    isAssignedToMe: false,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    closedAt: null,
    state: "OPEN",
    lifecycleState: "open",
    milestoneTitle: "v1.0",
    commentCount: 5,
  };

  const issue2: IssueResource = {
    key: "issue:other/repo#5",
    kind: "issue",
    repository: "other/repo",
    number: 5,
    title: "Docs update",
    body: "Docs description",
    url: "https://github.com/other/repo/issues/5",
    authorLogin: "dave",
    assigneeLogins: [],
    labels: ["docs"],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-04T00:00:00Z",
    isMine: false,
    isAssignedToMe: true,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    closedAt: null,
    state: "OPEN",
    lifecycleState: "open",
    milestoneTitle: "v2.0",
    commentCount: 1,
  };

  it("computes stats and extracts bidirectional references between PR and Issue", () => {
    const index = createResourceIndex([pr1, prDraft, issue1, issue2]);
    expect(index.stats.mineCount).toBe(2);
    expect(index.stats.draftsCount).toBe(1);
    expect(index.stats.milestoneOptions).toEqual(["v1.0", "v2.0"]);

    const queryResult = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });

    expect(queryResult.items).toHaveLength(4);
    expect(queryResult.summary).toEqual({
      total: 4,
      pullRequests: 2,
      issues: 2,
      needsAttention: 0,
    });

    const prItem = queryResult.items.find((i) => i.resource.key === pr1.key);
    const issueItem = queryResult.items.find(
      (i) => i.resource.key === issue1.key,
    );
    expect(prItem?.referencedTargets).toHaveLength(1);
    expect(prItem?.referencedTargets[0].key).toBe(issue1.key);
    expect(issueItem?.referencedTargets).toHaveLength(1);
    expect(issueItem?.referencedTargets[0].key).toBe(pr1.key);
  });

  it("identifies a clean passing PR without approval as awaiting review", () => {
    const index = createResourceIndex([
      {
        ...pr1,
        checkDetails: [{ name: "TypeScript checks", status: "success" }],
        number: 411,
        reviewDecision: "unknown",
      },
    ]);

    const result = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });
    expect(result.items[0]?.classification).toEqual({
      bucket: "waiting",
      reason: "Waiting for review",
    });
  });

  it("identifies a passing PR with unknown mergeability separately", () => {
    const index = createResourceIndex([
      {
        ...pr1,
        mergeable: "UNKNOWN",
        reviewDecision: "unknown",
      },
    ]);
    const result = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });
    expect(result.items[0]?.classification).toEqual({
      bucket: "waiting",
      reason: "Waiting for mergeability",
    });
  });
  it("enriches resources with workspaces and deduplicates directory agents", () => {
    const directory = {
      workspaces: [
        {
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "Paseo",
          name: "pr-10",
          archivingAt: null,
          remoteUrl: "https://github.com/getpaseo/paseo.git",
          pullRequestNumber: 10,
          worktreeSlug: "pr-10",
          activityAt: "2026-02-05T00:00:00Z",
        },
      ],
      agents: [
        {
          id: "agent-1",
          workspaceId: "ws-1",
          title: "PR Agent",
          status: "running" as const,
          requiresAttention: false,
          attentionReason: null,
          pendingPermissions: 0,
          updatedAt: "2026-02-05T00:00:00Z",
          labels: { "github-workbench.resource": pr1.key }, // matched by BOTH label and workspace
        },
        {
          id: "agent-2",
          title: "Direct resource agent",
          status: "idle" as const,
          requiresAttention: false,
          attentionReason: null,
          pendingPermissions: 0,
          updatedAt: "2026-02-05T00:00:00Z",
          labels: { "github-workbench.resource": pr1.key },
        },
      ],
    };

    const index = createResourceIndex([pr1], directory);
    const item = index.get(pr1.key);
    expect(item?.workspaceIds).toEqual(["ws-1"]);
    expect(item?.workspaceNames).toEqual(["pr-10"]);
    expect(item?.agents).toHaveLength(2);
    expect(item?.agents.map((agent) => agent.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);

    const queryResult = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });

    expect(queryResult.items[0].classification.bucket).toBe("being-handled");
    expect(queryResult.items[0].classification.reason).toBe("Agent is working");
  });

  it("filters and sorts correctly by criteria", () => {
    const index = createResourceIndex([pr1, prDraft, issue1, issue2]);

    // Quick filter: mine
    const mineResult = index.query({
      focusKey: null,
      quickFilter: "mine",
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });
    expect(mineResult.items).toHaveLength(2);
    expect(mineResult.summary.total).toBe(2);

    // Kind filter: issue
    const issueResult = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "issue",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "comments",
      direction: "desc",
    });
    expect(issueResult.items).toHaveLength(2);
    expect(issueResult.items[0].resource.key).toBe(issue1.key); // 5 comments vs 1

    // Milestone filter
    const milestoneResult = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: { kind: "named", title: "v1.0" },
      search: "",
      sort: "updated",
      direction: "desc",
    });
    expect(milestoneResult.items).toHaveLength(1);
    expect(milestoneResult.items[0].resource.key).toBe(issue1.key);

    // Search filter
    const searchResult = index.query({
      focusKey: null,
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "crashes",
      sort: "updated",
      direction: "desc",
    });
    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0].resource.key).toBe(issue1.key);
  });

  it("handles focusKey bypassing filters when found and returning empty when not found", () => {
    const index = createResourceIndex([pr1, issue1]);

    // Even with restrictive filters that don't match pr1, focusKey returns pr1
    const focused = index.query({
      focusKey: pr1.key,
      quickFilter: null,
      kind: "issue", // conflict with pr1 kind
      bucket: "open",
      label: "nonexistent",
      milestone: { kind: "named", title: "v1.0" },
      search: "random unmatched string",
      sort: "updated",
      direction: "desc",
    });
    expect(focused.items).toHaveLength(1);
    expect(focused.items[0].resource.key).toBe(pr1.key);
    expect(focused.summary.total).toBe(1);
    expect(focused.summary.pullRequests).toBe(1);

    // Missing focusKey returns empty
    const missing = index.query({
      focusKey: "pull-request:getpaseo/paseo#9999",
      quickFilter: null,
      kind: "all",
      bucket: "all",
      label: null,
      milestone: null,
      search: "",
      sort: "updated",
      direction: "desc",
    });
    expect(missing.items).toHaveLength(0);
    expect(missing.summary.total).toBe(0);
  });

  it("patches directory snapshots from Paseo updates without a full refetch", () => {
    const snapshot = {
      workspaces: [
        {
          id: "ws-1",
          projectId: "project-1",
          projectDisplayName: "Paseo",
          name: "Fix parser",
          archivingAt: null,
          remoteUrl: "git@github.com:getpaseo/paseo.git",
          pullRequestNumber: 10,
          worktreeSlug: "pr-10",
          activityAt: "2026-02-03T00:00:00Z",
        },
      ],
      agents: [
        {
          id: "agent-1",
          workspaceId: "ws-1",
          title: "Reviewer",
          status: "idle" as const,
          requiresAttention: false,
          attentionReason: null,
          pendingPermissions: 0,
          updatedAt: "2026-02-03T00:00:00Z",
          labels: {},
        },
      ],
    };

    const workspaceUpsert = {
      kind: "upsert",
      workspace: {
        id: "ws-1",
        projectId: "project-1",
        projectDisplayName: "Paseo",
        name: "Fix parser (updated)",
        archivingAt: null,
        gitRuntime: { remoteUrl: "https://github.com/getpaseo/paseo" },
        githubRuntime: { pullRequest: { number: 10 } },
        worktreeSlug: "pr-10",
        activityAt: "2026-02-04T00:00:00Z",
      },
    } as unknown as Parameters<typeof applyWorkspaceUpdate>[1];
    const agentUpsert = {
      kind: "upsert",
      agent: {
        id: "agent-1",
        workspaceId: "ws-1",
        title: "Reviewer (updated)",
        status: "running",
        requiresAttention: true,
        attentionReason: "permission",
        pendingPermissions: [{ id: "permission-1" }],
        updatedAt: "2026-02-04T00:00:00Z",
        labels: { role: "reviewer" },
      },
    } as unknown as Parameters<typeof applyAgentUpdate>[1];

    const updated = applyAgentUpdate(
      applyWorkspaceUpdate(snapshot, workspaceUpsert),
      agentUpsert,
    );
    expect(updated.workspaces).toHaveLength(1);
    expect(updated.workspaces[0]?.name).toBe("Fix parser (updated)");
    expect(updated.workspaces[0]?.remoteUrl).toBe(
      "https://github.com/getpaseo/paseo",
    );
    expect(updated.agents[0]?.title).toBe("Reviewer (updated)");
    expect(updated.agents[0]?.pendingPermissions).toBe(1);

    const removed = applyAgentUpdate(
      applyWorkspaceUpdate(updated, { kind: "remove", id: "ws-1" }),
      { kind: "remove", agentId: "agent-1" },
    );
    expect(removed.workspaces).toHaveLength(0);
    expect(removed.agents).toHaveLength(0);
  });
});

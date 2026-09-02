import { describe, expect, test } from "bun:test";
import {
  adjustPendingResourceCount,
  issueBranchSlug,
  mergeRefreshedResource,
  normalizeGitHubRepository,
  openExternalUrl,
  type PullRequestResource,
  resourceKey,
  resourceMatchesWorkspace,
} from "./github-workbench.shared";
import { resourceAccessibilityLabel } from "./workbench-ui.client";

function pullRequest(
  overrides: Partial<PullRequestResource> = {},
): PullRequestResource {
  return {
    key: resourceKey("pull-request", "getpaseo/paseo", 42),
    kind: "pull-request",
    repository: "getpaseo/paseo",
    number: 42,
    title: "Test pull request",
    url: "https://github.com/getpaseo/paseo/pull/42",
    authorLogin: "ada",
    assigneeLogins: [],
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    isMine: true,
    isAssignedToMe: false,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    checksStatus: "success",
    checkDetails: [],
    commentCount: 0,
    reviewDecision: "approved",
    mergeable: "MERGEABLE",
    reviewRequestedFromMe: false,
    ...overrides,
  };
}

describe("GitHub workbench shared primitives", () => {
  test("normalizes HTTPS and SSH GitHub remotes", () => {
    expect(
      normalizeGitHubRepository("https://github.com/GetPaseo/paseo.git"),
    ).toBe("GetPaseo/paseo");
    expect(normalizeGitHubRepository("git@github.com:getpaseo/paseo.git")).toBe(
      "getpaseo/paseo",
    );
    expect(
      normalizeGitHubRepository("https://gitlab.com/getpaseo/paseo.git"),
    ).toBeNull();
  });

  test("creates predictable Issue branch names", () => {
    expect(issueBranchSlug(7, "Fix unicode — and spaces!")).toBe(
      "issue-7-fix-unicode-and-spaces",
    );
    expect(issueBranchSlug(7, "中文")).toBe("issue-7-task");
  });

  test("matches a PR workspace by its persisted worktree slug or PR number", () => {
    const prInput = {
      kind: "pull-request" as const,
      repository: "getpaseo/paseo",
      number: 42,
    };
    expect(
      resourceMatchesWorkspace(prInput, {
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        pullRequestNumber: undefined,
        worktreeSlug: "pr-42",
        archivingAt: null,
      }),
    ).toBe(true);
    expect(
      resourceMatchesWorkspace(prInput, {
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        pullRequestNumber: 42,
        worktreeSlug: "other",
        archivingAt: null,
      }),
    ).toBe(true);
    expect(
      resourceMatchesWorkspace(prInput, {
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        pullRequestNumber: 42,
        worktreeSlug: "pr-42",
        archivingAt: "2026-02-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  test("matches an Issue workspace only by its slug prefix", () => {
    const issueInput = {
      kind: "issue" as const,
      repository: "getpaseo/paseo",
      number: 7,
    };
    expect(
      resourceMatchesWorkspace(issueInput, {
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeSlug: "issue-7-fix-bug",
        archivingAt: null,
      }),
    ).toBe(true);
    expect(
      resourceMatchesWorkspace(issueInput, {
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        worktreeSlug: "feature-unrelated",
        archivingAt: null,
      }),
    ).toBe(false);
  });

  test("tracks workspace creation pending state independently per resource", () => {
    const withFirst = adjustPendingResourceCount(new Map(), "pr:repo#1", 1);
    const withBoth = adjustPendingResourceCount(withFirst, "issue:repo#2", 1);
    const afterFirstSettles = adjustPendingResourceCount(
      withBoth,
      "pr:repo#1",
      -1,
    );

    expect(afterFirstSettles.has("pr:repo#1")).toBe(false);
    expect(afterFirstSettles.get("issue:repo#2")).toBe(1);
  });

  test("merges refreshed resource without losing client attached workspace or agent state", () => {
    const current = pullRequest({
      workspaceIds: ["ws-1"],
      workspaceNames: ["pr-42"],
      agents: [
        {
          id: "agent-1",
          title: "Agent",
          status: "running",
          requiresAttention: false,
          attentionReason: null,
          pendingPermissions: 0,
          updatedAt: "2026-02-01T00:00:00Z",
        },
      ],
      isMine: true,
      reviewRequestedFromMe: true,
    });
    const refreshed: PullRequestResource = {
      ...current,
      title: "New Title",
      workspaceIds: [],
      workspaceNames: [],
      agents: [],
      isMine: false,
      reviewRequestedFromMe: false,
    };

    const merged = mergeRefreshedResource(current, refreshed);
    expect(merged.title).toBe("New Title");
    expect(merged.workspaceIds).toEqual(["ws-1"]);
    expect(merged.workspaceNames).toEqual(["pr-42"]);
    expect(merged.agents).toHaveLength(1);
    expect(merged.isMine).toBe(true);
    if (merged.kind === "pull-request") {
      expect(merged.reviewRequestedFromMe).toBe(true);
    }
  });

  test("formats accessibility labels properly", () => {
    expect(
      resourceAccessibilityLabel("Pull Request", "getpaseo/paseo", 42, "Title"),
    ).toBe("Pull Request getpaseo/paseo #42: Title");
  });
});

describe("external URL opening", () => {
  test("uses the desktop opener for valid HTTP URLs", async () => {
    const desktopUrls: string[] = [];
    const linkingUrls: string[] = [];

    await expect(
      openExternalUrl("http://github.com/getpaseo/paseo", {
        desktopOpener: {
          openUrl: (url) => {
            desktopUrls.push(url);
          },
        },
        linking: {
          openURL: (url) => {
            linkingUrls.push(url);
          },
        },
      }),
    ).resolves.toBe(true);
    expect(desktopUrls).toEqual(["http://github.com/getpaseo/paseo"]);
    expect(linkingUrls).toEqual([]);
  });

  test("falls back to Linking when the desktop opener fails", async () => {
    const linkingUrls: string[] = [];

    await expect(
      openExternalUrl("https://github.com/getpaseo/paseo", {
        desktopOpener: {
          openUrl: () => {
            throw new Error("desktop unavailable");
          },
        },
        linking: {
          openURL: (url) => {
            linkingUrls.push(url);
          },
        },
      }),
    ).resolves.toBe(true);
    expect(linkingUrls).toEqual(["https://github.com/getpaseo/paseo"]);
  });

  test("falls back to Linking when no desktop opener is available", async () => {
    const linkingUrls: string[] = [];

    await expect(
      openExternalUrl("https://github.com/getpaseo/paseo", {
        linking: {
          openURL: (url) => {
            linkingUrls.push(url);
          },
        },
      }),
    ).resolves.toBe(true);
    expect(linkingUrls).toEqual(["https://github.com/getpaseo/paseo"]);
  });

  test("falls back to Linking when the desktop opener rejects", async () => {
    let linkingCalls = 0;

    await expect(
      openExternalUrl("https://github.com/getpaseo/paseo", {
        desktopOpener: {
          openUrl: () => Promise.reject(new Error("desktop unavailable")),
        },
        linking: {
          openURL: () => {
            linkingCalls += 1;
          },
        },
      }),
    ).resolves.toBe(true);
    expect(linkingCalls).toBe(1);
  });

  test("falls back to Linking when the desktop opener returns false", async () => {
    let linkingCalls = 0;

    await expect(
      openExternalUrl("https://github.com/getpaseo/paseo", {
        desktopOpener: { openUrl: () => false },
        linking: {
          openURL: () => {
            linkingCalls += 1;
          },
        },
      }),
    ).resolves.toBe(true);
    expect(linkingCalls).toBe(1);
  });

  test("returns false when neither opener succeeds", async () => {
    await expect(
      openExternalUrl("https://github.com/getpaseo/paseo", {
        desktopOpener: { openUrl: () => false },
        linking: {
          openURL: () => Promise.reject(new Error("Linking unavailable")),
        },
      }),
    ).resolves.toBe(false);
  });

  test("does not open invalid or non-HTTP URLs", async () => {
    let desktopCalls = 0;
    let linkingCalls = 0;
    const dependencies = {
      desktopOpener: {
        openUrl: () => {
          desktopCalls += 1;
        },
      },
      linking: {
        openURL: () => {
          linkingCalls += 1;
        },
      },
    };

    await expect(openExternalUrl("not a URL", dependencies)).resolves.toBe(
      false,
    );
    await expect(
      openExternalUrl("file:///tmp/paseo", dependencies),
    ).resolves.toBe(false);
    expect(desktopCalls).toBe(0);
    expect(linkingCalls).toBe(0);
  });
});

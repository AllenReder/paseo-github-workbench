import { describe, expect, it } from "bun:test";
import { createGitHubResourceIntake } from "./github-resource-intake.server";

describe("GitHubResourceIntake", () => {
  it("coalesces concurrent repository queries and caches results for 30 seconds", async () => {
    let prCalls = 0;
    let issueCalls = 0;
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "pr") {
        prCalls += 1;
        return {
          stdout: JSON.stringify([
            {
              number: 42,
              title: "Test PR",
              url: "https://github.com/getpaseo/paseo/pull/42",
              author: { login: "alice" },
              headRefName: "feature-branch",
              baseRefName: "main",
              isDraft: false,
              labels: { nodes: [{ name: "enhancement" }] },
              createdAt: "2026-02-01T00:00:00Z",
              updatedAt: "2026-02-02T00:00:00Z",
              reviewDecision: "APPROVED",
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  nodes: [
                    {
                      name: "test",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                    },
                  ],
                },
              },
              mergeable: "MERGEABLE",
              comments: { totalCount: 2 },
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "issue") {
        issueCalls += 1;
        return {
          stdout: JSON.stringify([
            {
              number: 99,
              title: "Test Issue",
              url: "https://github.com/getpaseo/paseo/issues/99",
              author: { login: "bob" },
              assignees: { nodes: [] },
              labels: { nodes: [] },
              milestone: null,
              comments: { totalCount: 0 },
              createdAt: "2026-02-01T00:00:00Z",
              updatedAt: "2026-02-01T00:00:00Z",
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const [first, second] = await Promise.all([
      intake.listResources({
        scope: "repository",
        repository: "getpaseo/paseo",
      }),
      intake.listResources({
        scope: "repository",
        repository: "getpaseo/paseo",
      }),
    ]);

    expect(prCalls).toBe(1);
    expect(issueCalls).toBe(1);
    expect(first.resources).toHaveLength(2);
    expect(second.resources).toHaveLength(2);
    expect(first.resources[0].key).toBe("pull-request:getpaseo/paseo#42");
    expect(first.resources[1].key).toBe("issue:getpaseo/paseo#99");

    const third = await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
    });
    expect(prCalls).toBe(1);
    expect(issueCalls).toBe(1);
    expect(third.resources).toHaveLength(2);

    const fourth = await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
      forceRefresh: true,
    });
    expect(prCalls).toBe(2);
    expect(issueCalls).toBe(2);
    expect(fourth.resources).toHaveLength(2);
  });

  it("handles ENOENT by returning structured gh-cli-not-found warning without caching failure", async () => {
    let calls = 0;
    const intake = createGitHubResourceIntake(async () => {
      calls += 1;
      const error = new Error("spawn gh ENOENT") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    });

    const result = await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
    });

    expect(calls).toBe(2); // pr list and issue list run concurrently
    expect(result.resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("gh-cli-not-found");

    // Failure was not cached
    await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
    });
    expect(calls).toBe(4);
  });

  it("handles account scope, resolves viewer, and merges relationship flags", async () => {
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "api" && args[1] === "user") {
        return { stdout: "octocat\n", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              authoredPr: {
                nodes: [
                  {
                    number: 10,
                    title: "Authored PR",
                    url: "https://github.com/org/repo/pull/10",
                    repository: { nameWithOwner: "org/repo" },
                    author: { login: "octocat" },
                    createdAt: "2026-02-01T00:00:00Z",
                    updatedAt: "2026-02-02T00:00:00Z",
                    isDraft: false,
                    headRefName: "patch",
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
                    reviewDecision: "APPROVED",
                    comments: { totalCount: 1 },
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                    statusCheckRollup: { state: "SUCCESS" },
                  },
                ],
              },
              reviewPr: {
                nodes: [
                  {
                    number: 10,
                    title: "Authored PR",
                    url: "https://github.com/org/repo/pull/10",
                    repository: { nameWithOwner: "org/repo" },
                    author: { login: "octocat" },
                    createdAt: "2026-02-01T00:00:00Z",
                    updatedAt: "2026-02-02T00:00:00Z",
                    isDraft: false,
                    headRefName: "patch",
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
                    reviewDecision: "APPROVED",
                    comments: { totalCount: 1 },
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                    statusCheckRollup: { state: "SUCCESS" },
                  },
                ],
              },
              authoredIssue: {
                nodes: [
                  {
                    number: 20,
                    title: "Authored Issue",
                    url: "https://github.com/org/repo/issues/20",
                    repository: { nameWithOwner: "org/repo" },
                    author: { login: "octocat" },
                    createdAt: "2026-02-01T00:00:00Z",
                    updatedAt: "2026-02-01T00:00:00Z",
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                    milestone: { title: "v1.0" },
                    comments: { totalCount: 0 },
                  },
                ],
              },
              assignedIssue: {
                nodes: [
                  {
                    number: 20,
                    title: "Authored Issue",
                    url: "https://github.com/org/repo/issues/20",
                    repository: { nameWithOwner: "org/repo" },
                    author: { login: "octocat" },
                    createdAt: "2026-02-01T00:00:00Z",
                    updatedAt: "2026-02-01T00:00:00Z",
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                    milestone: { title: "v1.0" },
                    comments: { totalCount: 0 },
                  },
                ],
              },
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await intake.listResources({ scope: "account" });
    expect(result.resources).toHaveLength(2);
    const pr = result.resources.find((r) => r.kind === "pull-request");
    const issue = result.resources.find((r) => r.kind === "issue");
    expect(pr).toBeDefined();
    expect(pr?.isMine).toBe(true);
    if (pr && pr.kind === "pull-request") {
      expect(pr.reviewRequestedFromMe).toBe(true);
    }
    expect(issue).toBeDefined();
    expect(issue?.isMine).toBe(true);
    expect(issue?.isAssignedToMe).toBe(true);
  });

  it("marks a completed successful gh pr view check rollup as passing", async () => {
    const intake = createGitHubResourceIntake(async () => ({
      stdout: JSON.stringify({
        number: 411,
        title: "Completed CI",
        url: "https://github.com/AllenReder/mc-agent-runtime/pull/411",
        author: { login: "AllenReder" },
        headRefName: "fast-insect",
        baseRefName: "main",
        isDraft: false,
        labels: [],
        updatedAt: "2026-09-02T08:50:19Z",
        createdAt: "2026-09-02T08:45:43Z",
        reviewDecision: "",
        statusCheckRollup: [
          {
            name: "TypeScript checks",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        mergeable: "MERGEABLE",
        comments: [],
      }),
      stderr: "",
    }));

    const result = await intake.refreshResource({
      kind: "pull-request",
      repository: "AllenReder/mc-agent-runtime",
      number: 411,
    });

    expect(result.resource).toMatchObject({
      checksStatus: "success",
      checkDetails: [{ name: "TypeScript checks", status: "success" }],
    });
  });
  it("refreshes a single resource with pr view or issue view", async () => {
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 15,
            title: "Refreshed PR",
            url: "https://github.com/owner/repo/pull/15",
            author: { login: "dev" },
            headRefName: "feature",
            baseRefName: "main",
            isDraft: false,
            labels: [],
            updatedAt: "2026-02-05T00:00:00Z",
            createdAt: "2026-02-01T00:00:00Z",
            reviewDecision: "CHANGES_REQUESTED",
            statusCheckRollup: [
              { name: "build", status: "COMPLETED", conclusion: "FAILURE" },
            ],
            mergeable: "CONFLICTING",
            comments: 5,
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await intake.refreshResource({
      kind: "pull-request",
      repository: "owner/repo",
      number: 15,
    });

    expect(result.resource.title).toBe("Refreshed PR");
    if (result.resource.kind === "pull-request") {
      expect(result.resource.reviewDecision).toBe("changes_requested");
      expect(result.resource.mergeable).toBe("CONFLICTING");
      expect(result.resource.checksStatus).toBe("failure");
      expect(result.resource.checkDetails).toEqual([
        { name: "build", status: "failure" },
      ]);
    }
  });

  it("throws friendly error on refreshResource failure", async () => {
    const intake = createGitHubResourceIntake(async () => {
      const error = new Error("HTTP 404: Not Found") as Error & {
        stderr: string;
      };
      error.stderr = "could not resolve to a repository";
      throw error;
    });

    await expect(
      intake.refreshResource({
        kind: "issue",
        repository: "missing/repo",
        number: 1,
      }),
    ).rejects.toThrow(
      "The GitHub repository is unavailable or you do not have access.",
    );
  });

  it("runs diagnostics and classifies status correctly", async () => {
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "api" && args[1] === "user") {
        return { stdout: "alice\n", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "rate_limit") {
        return {
          stdout: JSON.stringify({
            limit: 5000,
            remaining: 4950,
            reset: 1770000000,
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diag = await intake.diagnostics({});
    expect(diag.status).toBe("ok");
    expect(diag.viewerLogin).toBe("alice");
    expect(diag.remaining).toBe(4950);
    expect(diag.limit).toBe(5000);
    expect(diag.resetAt).toBe(new Date(1770000000 * 1000).toISOString());
  });

  it("handles auth-required and rate-limited diagnostic states", async () => {
    const authIntake = createGitHubResourceIntake(async () => {
      const error = new Error("auth login required") as Error & {
        stderr: string;
      };
      error.stderr = "not logged in to any GitHub hosts";
      throw error;
    });
    const authDiag = await authIntake.diagnostics({});
    expect(authDiag.status).toBe("auth-required");
    expect(authDiag.viewerLogin).toBeNull();

    const rateIntake = createGitHubResourceIntake(async () => {
      const error = new Error("rate limit exceeded") as Error & {
        stderr: string;
      };
      error.stderr = "HTTP 403: API rate limit reached";
      throw error;
    });
    const rateDiag = await rateIntake.diagnostics({});
    expect(rateDiag.status).toBe("rate-limited");
  });
});

import { describe, expect, it } from "bun:test";
import { createGitHubResourceIntake } from "./github-resource-intake.server";

describe("GitHubResourceIntake", () => {
  it("coalesces concurrent repository queries and caches the result", async () => {
    let calls = 0;
    const intake = createGitHubResourceIntake(async (args) => {
      expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(args.join(" ")).not.toContain("body");
      expect(args.join(" ")).not.toContain("contexts(first: 20)");
      expect(args.join(" ")).toContain("statusCheckRollup { state }");
      calls += 1;
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 42,
                    title: "Test PR",
                    url: "https://github.com/getpaseo/paseo/pull/42",
                    body: "PR list description",
                    author: { login: "alice" },
                    repository: { nameWithOwner: "getpaseo/paseo" },
                    assignees: { nodes: [] },
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
                ],
              },
              issues: {
                nodes: [
                  {
                    number: 99,
                    title: "Test Issue",
                    body: "Issue list description",
                    url: "https://github.com/getpaseo/paseo/issues/99",
                    repository: { nameWithOwner: "getpaseo/paseo" },
                    author: { login: "bob" },
                    assignees: { nodes: [] },
                    labels: { nodes: [] },
                    milestone: null,
                    comments: { totalCount: 0 },
                    createdAt: "2026-02-01T00:00:00Z",
                    updatedAt: "2026-02-01T00:00:00Z",
                  },
                ],
              },
            },
          },
        }),
        stderr: "",
      };
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

    expect(calls).toBe(1);
    expect(
      first.resources.find((resource) => resource.kind === "pull-request")
        ?.body,
    ).toBe("PR list description");
    expect(
      first.resources.find((resource) => resource.kind === "issue")?.body,
    ).toBe("Issue list description");
    expect(first.resources).toHaveLength(2);
    expect(second.resources).toHaveLength(2);
    expect(first.resources[0].key).toBe("pull-request:getpaseo/paseo#42");
    expect(first.resources[1].key).toBe("issue:getpaseo/paseo#99");

    const third = await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
    });
    expect(calls).toBe(1);
    expect(third.resources).toHaveLength(2);

    const fourth = await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
      forceRefresh: true,
    });
    expect(calls).toBe(2);
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

    expect(calls).toBe(1); // one batched GraphQL query for the repository
    expect(result.resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("gh-cli-not-found");

    // Failure was not cached
    await intake.listResources({
      scope: "repository",
      repository: "getpaseo/paseo",
    });
    expect(calls).toBe(2);
  });

  it("does not cache a null repository GraphQL error as an empty result", async () => {
    let calls = 0;
    const intake = createGitHubResourceIntake(async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [
            {
              message:
                "Could not resolve to a Repository with the name 'missing/repo'.",
            },
          ],
        }),
        stderr: "",
      };
    });

    const first = await intake.listResources({
      scope: "repository",
      repository: "missing/repo",
    });
    const second = await intake.listResources({
      scope: "repository",
      repository: "missing/repo",
    });

    expect(first.resources).toHaveLength(0);
    expect(first.warnings[0]?.code).toBe("repository-unavailable");
    expect(second.warnings[0]?.code).toBe("repository-unavailable");
    expect(calls).toBe(2);
  });

  it("handles account scope, resolves viewer, and merges relationship flags", async () => {
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "api" && args[1] === "graphql") {
        const queryArg =
          args.find((arg) => arg.startsWith("query=")) ??
          (args[args.indexOf("-f") + 1]?.startsWith("query=")
            ? args[args.indexOf("-f") + 1]
            : undefined);
        if (!queryArg) {
          throw new Error("Missing query argument in gh api graphql call");
        }
        const rawQuery = queryArg.slice("query=".length);

        // Balanced braces helper
        let braceDepth = 0;
        let hadOpenBrace = false;
        for (const char of rawQuery) {
          if (char === "{") {
            braceDepth++;
            hadOpenBrace = true;
          } else if (char === "}") {
            braceDepth--;
            expect(braceDepth).toBeGreaterThanOrEqual(0);
          }
        }
        expect(hadOpenBrace).toBe(true);
        expect(braceDepth).toBe(0);

        if (rawQuery.includes("WorkbenchViewer")) {
          return {
            stdout: JSON.stringify({ data: { viewer: { login: "octocat" } } }),
            stderr: "",
          };
        }

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

  it("marks a completed successful GraphQL check rollup as passing", async () => {
    const intake = createGitHubResourceIntake(async () => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 411,
              title: "Completed CI",
              url: "https://github.com/AllenReder/mc-agent-runtime/pull/411",
              repository: { nameWithOwner: "AllenReder/mc-agent-runtime" },
              author: { login: "AllenReder" },
              assignees: { nodes: [] },
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
            },
          },
        },
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
  it("refreshes a single resource with GraphQL", async () => {
    const intake = createGitHubResourceIntake(async (args) => {
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 15,
                  title: "Refreshed PR",
                  body: "Refreshed description",
                  url: "https://github.com/owner/repo/pull/15",
                  repository: { nameWithOwner: "owner/repo" },
                  author: { login: "dev" },
                  assignees: { nodes: [] },
                  headRefName: "feature",
                  baseRefName: "main",
                  isDraft: false,
                  labels: [],
                  updatedAt: "2026-02-05T00:00:00Z",
                  createdAt: "2026-02-01T00:00:00Z",
                  reviewDecision: "CHANGES_REQUESTED",
                  statusCheckRollup: [
                    {
                      name: "build",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                    },
                  ],
                  mergeable: "CONFLICTING",
                  comments: 5,
                },
              },
            },
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

    expect(result.resource.body).toBe("Refreshed description");
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

  it("uses GH_TOKEN's native GraphQL transport without starting gh", async () => {
    let ghCalls = 0;
    let fetchCalls = 0;
    const intake = createGitHubResourceIntake(
      async () => {
        ghCalls += 1;
        throw new Error("gh must not run when a token is configured");
      },
      {
        token: "test-token",
        fetch: async (_url, init) => {
          fetchCalls += 1;
          const headers = init?.headers ?? {};
          expect((headers as Record<string, string>).Authorization).toBe(
            "Bearer test-token",
          );
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequests: { nodes: [] },
                  issues: {
                    nodes: [
                      {
                        number: 99,
                        title: "Native API issue",
                        body: "No subprocess required",
                        url: "https://github.com/owner/repo/issues/99",
                        repository: { nameWithOwner: "owner/repo" },
                        author: { login: "octocat" },
                        assignees: { nodes: [] },
                        labels: { nodes: [] },
                        comments: { totalCount: 0 },
                        createdAt: "2026-02-01T00:00:00Z",
                        updatedAt: "2026-02-01T00:00:00Z",
                      },
                    ],
                  },
                },
              },
              errors: [{ message: "Resource not accessible by integration" }],
            }),
            { status: 200 },
          );
        },
      },
    );

    const first = await intake.listResources({
      scope: "repository",
      repository: "owner/repo",
    });
    const second = await intake.listResources({
      scope: "repository",
      repository: "owner/repo",
    });

    expect(first.resources).toHaveLength(1);
    expect(second.resources).toHaveLength(1);
    expect(first.warnings).toEqual([
      {
        code: "github-query-failed",
        message:
          "Some GitHub fields could not be loaded: Resource not accessible by integration",
      },
    ]);
    expect(fetchCalls).toBe(1);
    expect(ghCalls).toBe(0);
  });
});

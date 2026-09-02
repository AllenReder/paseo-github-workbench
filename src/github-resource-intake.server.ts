import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { z } from "zod";
import {
  type GitHubResource,
  type IssueResource,
  type listResourcesRpc,
  type PullRequestResource,
  type refreshResourceRpc,
  resourceKey,
  type WarningSchema,
} from "./github-workbench.shared";

export type GitHubCommandRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type GitHubResourceIntake = {
  listResources(
    input: z.infer<typeof listResourcesRpc.input>,
  ): Promise<z.infer<typeof listResourcesRpc.output>>;
  refreshResource(
    input: z.infer<typeof refreshResourceRpc.input>,
  ): Promise<z.infer<typeof refreshResourceRpc.output>>;
};

type Warning = z.infer<typeof WarningSchema>;
type CacheValue = z.infer<typeof listResourcesRpc.output>;

const execFile = promisify(execFileCallback);
const CACHE_TTL_MS = 30_000;

const pullRequestJsonFields = [
  "number",
  "title",
  "url",
  "body",
  "author",
  "headRefName",
  "baseRefName",
  "isDraft",
  "state",
  "mergedAt",
  "closedAt",
  "labels",
  "updatedAt",
  "createdAt",
  "reviewDecision",
  "statusCheckRollup",
  "mergeable",
  "comments",
].join(",");

const issueJsonFields = [
  "number",
  "title",
  "url",
  "body",
  "author",
  "assignees",
  "labels",
  "milestone",
  "comments",
  "createdAt",
  "updatedAt",
  "closedAt",
  "state",
].join(",");

const accountQuery = `
query Workbench($authoredPr: String!, $reviewPr: String!, $authoredIssue: String!, $assignedIssue: String!) {
  authoredPr: search(query: $authoredPr, type: ISSUE, first: 100) { nodes { ... on PullRequest { number title body url state mergedAt closedAt createdAt updatedAt isDraft headRefName baseRefName mergeable reviewDecision comments { totalCount } author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
  reviewPr: search(query: $reviewPr, type: ISSUE, first: 100) { nodes { ... on PullRequest { number title body url state mergedAt closedAt createdAt updatedAt isDraft headRefName baseRefName mergeable reviewDecision comments { totalCount } author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
  authoredIssue: search(query: $authoredIssue, type: ISSUE, first: 100) { nodes { ... on Issue { number title body url state closedAt createdAt updatedAt author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } milestone { title } comments { totalCount } } } }
  assignedIssue: search(query: $assignedIssue, type: ISSUE, first: 100) { nodes { ... on Issue { number title body url state closedAt createdAt updatedAt author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } milestone { title } comments { totalCount } } } }
}`;

function defaultCommandRunner(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFile("gh", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function errorWarning(error: unknown): Warning {
  const record = error as NodeJS.ErrnoException & {
    stderr?: string;
    message?: string;
  };
  const text = [record.message, record.stderr].filter(Boolean).join("\n");
  if (record.code === "ENOENT")
    return {
      code: "gh-cli-not-found",
      message: "GitHub CLI (gh) is not installed on the Paseo daemon host.",
    };
  if (/authentication|not logged in|auth login/i.test(text))
    return {
      code: "gh-not-authenticated",
      message:
        "Authenticate gh on the Paseo daemon host before using GitHub Workbench.",
    };
  if (/rate limit|api rate limit|HTTP 403/i.test(text))
    return {
      code: "github-rate-limited",
      message: "GitHub API rate limit reached. Try again later.",
    };
  if (/HTTP 404|could not resolve to a repository|not found/i.test(text))
    return {
      code: "repository-unavailable",
      message:
        "The GitHub repository is unavailable or you do not have access.",
    };
  return {
    code: "github-query-failed",
    message: text || "GitHub CLI query failed.",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringsFromNodes(value: unknown, property = "name"): string[] {
  const record = asRecord(value);
  const nodes = Array.isArray(record?.nodes)
    ? record.nodes
    : Array.isArray(value)
      ? value
      : [];
  return nodes.flatMap((item) => {
    const itemRecord = asRecord(item);
    const candidate = itemRecord ? asString(itemRecord[property]) : null;
    return candidate ? [candidate] : [];
  });
}

function loginFrom(value: unknown): string | null {
  const record = asRecord(value);
  return record ? asString(record.login) : null;
}

function labelsFrom(value: unknown): string[] {
  return stringsFromNodes(value);
}

function summarizeChecks(checks: unknown): PullRequestResource["checksStatus"] {
  if (!Array.isArray(checks) || checks.length === 0) return "none";
  let sawKnown = false;
  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const record = check as Record<string, unknown>;
    const status =
      typeof record.status === "string" ? record.status.toUpperCase() : "";
    if (status && status !== "COMPLETED") return "pending";
    const conclusion =
      typeof record.conclusion === "string"
        ? record.conclusion.toUpperCase()
        : "";
    if (
      ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
        conclusion,
      )
    )
      return "failure";
    if (["SUCCESS", "NEUTRAL", "SKIPPED", "STALE"].includes(conclusion))
      sawKnown = true;
  }
  return sawKnown ? "success" : "unknown";
}

function checkStatusFromGraphql(
  value: unknown,
): PullRequestResource["checksStatus"] {
  if (Array.isArray(value)) return summarizeChecks(value);
  const rollup = asRecord(value);
  if (!rollup) return "none";
  const state = asString(rollup.state)?.toUpperCase();
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (
    ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
      state ?? "",
    )
  )
    return "failure";
  if (state === "SUCCESS") return "success";
  const contexts = asRecord(rollup.contexts);
  return summarizeChecks(contexts?.nodes);
}

function checkDetailsFrom(value: unknown): PullRequestResource["checkDetails"] {
  const records = Array.isArray(value) ? value : asRecord(value)?.nodes;
  if (!Array.isArray(records)) return [];
  return records
    .flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      const name =
        asString(record.name) ?? asString(record.context) ?? "Unnamed check";
      const status = asString(record.status)?.toUpperCase();
      const conclusion = asString(record.conclusion)?.toUpperCase();
      const normalized: PullRequestResource["checkDetails"][number]["status"] =
        conclusion === "FAILURE" ||
        conclusion === "ERROR" ||
        conclusion === "CANCELLED" ||
        conclusion === "TIMED_OUT" ||
        conclusion === "ACTION_REQUIRED" ||
        [
          "FAILURE",
          "ERROR",
          "CANCELLED",
          "TIMED_OUT",
          "ACTION_REQUIRED",
        ].includes(status ?? "")
          ? "failure"
          : ["IN_PROGRESS", "PENDING", "QUEUED", "EXPECTED"].includes(
                status ?? "",
              )
            ? "pending"
            : conclusion === "SUCCESS" || status === "SUCCESS"
              ? "success"
              : "unknown";
      return [{ name, status: normalized }];
    })
    .sort((left, right) => {
      const rank = (status: string) =>
        status === "failure" ? 0 : status === "pending" ? 1 : 2;
      return (
        rank(left.status) - rank(right.status) ||
        left.name.localeCompare(right.name)
      );
    });
}

function makePullRequest(
  record: Record<string, unknown>,
  flags: { isMine: boolean; reviewRequestedFromMe: boolean },
): PullRequestResource | null {
  const repository = asString(asRecord(record.repository)?.nameWithOwner);
  const number = asNumber(record.number);
  const url = asString(record.url);
  if (!repository || !number || !url) return null;
  const rawState = asString(record.state)?.toUpperCase();
  const mergedAt = asString(record.mergedAt);
  const closedAt = asString(record.closedAt);
  const state: PullRequestResource["state"] =
    rawState === "MERGED" || mergedAt !== null
      ? "MERGED"
      : rawState === "CLOSED"
        ? "CLOSED"
        : "OPEN";
  const lifecycleState: PullRequestResource["lifecycleState"] =
    state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";
  return {
    key: resourceKey("pull-request", repository, number),
    kind: "pull-request",
    repository,
    number,
    title: asString(record.title) ?? `Pull request #${number}`,
    body: asString(record.body) ?? "",
    url,
    authorLogin: loginFrom(record.author),
    assigneeLogins: stringsFromNodes(record.assignees, "login"),
    labels: labelsFrom(record.labels),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    closedAt: closedAt ?? null,
    mergedAt: mergedAt ?? null,
    state,
    lifecycleState,
    commentCount: asNumber(asRecord(record.comments)?.totalCount) ?? 0,
    isMine: flags.isMine,
    isAssignedToMe: false,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    isDraft: record.isDraft === true,
    headRefName: asString(record.headRefName),
    checkDetails: checkDetailsFrom(record.statusCheckRollup),
    baseRefName: asString(record.baseRefName),
    checksStatus: record.statusCheckRollup
      ? checkStatusFromGraphql(record.statusCheckRollup)
      : summarizeChecks(record.statusCheckRollup),
    reviewDecision: (["approved", "changes_requested", "pending"].includes(
      String(record.reviewDecision).toLowerCase(),
    )
      ? String(record.reviewDecision).toLowerCase()
      : "unknown") as PullRequestResource["reviewDecision"],
    mergeable: (["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(
      String(record.mergeable).toUpperCase(),
    )
      ? String(record.mergeable).toUpperCase()
      : "UNKNOWN") as PullRequestResource["mergeable"],
    reviewRequestedFromMe: flags.reviewRequestedFromMe,
  };
}

function makeIssue(
  record: Record<string, unknown>,
  flags: { isMine: boolean; isAssignedToMe: boolean },
): IssueResource | null {
  const repository = asString(asRecord(record.repository)?.nameWithOwner);
  const number = asNumber(record.number);
  const url = asString(record.url);
  if (!repository || !number || !url) return null;
  const rawState = asString(record.state)?.toUpperCase();
  const closedAt = asString(record.closedAt);
  const state: IssueResource["state"] =
    rawState === "CLOSED" || closedAt !== null ? "CLOSED" : "OPEN";
  const lifecycleState: IssueResource["lifecycleState"] =
    state === "CLOSED" ? "closed" : "open";
  return {
    key: resourceKey("issue", repository, number),
    kind: "issue",
    repository,
    number,
    title: asString(record.title) ?? `Issue #${number}`,
    body: asString(record.body) ?? "",
    url,
    authorLogin: loginFrom(record.author),
    assigneeLogins: stringsFromNodes(record.assignees, "login"),
    labels: labelsFrom(record.labels),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    closedAt: closedAt ?? null,
    state,
    lifecycleState,
    isMine: flags.isMine,
    isAssignedToMe: flags.isAssignedToMe,
    workspaceIds: [],
    workspaceNames: [],
    agents: [],
    milestoneTitle: asString(asRecord(record.milestone)?.title),
    commentCount: asNumber(asRecord(record.comments)?.totalCount) ?? 0,
  };
}

function mergeResources(resources: GitHubResource[]): GitHubResource[] {
  const merged = new Map<string, GitHubResource>();
  for (const resource of resources) {
    const existing = merged.get(resource.key);
    if (!existing) {
      merged.set(resource.key, resource);
      continue;
    }
    if (resource.kind === "pull-request" && existing.kind === "pull-request") {
      merged.set(resource.key, {
        ...existing,
        ...resource,
        isMine: existing.isMine || resource.isMine,
        reviewRequestedFromMe:
          existing.reviewRequestedFromMe || resource.reviewRequestedFromMe,
      });
    } else if (resource.kind === "issue" && existing.kind === "issue") {
      merged.set(resource.key, {
        ...existing,
        ...resource,
        isMine: existing.isMine || resource.isMine,
        isAssignedToMe: existing.isAssignedToMe || resource.isAssignedToMe,
      });
    }
  }
  return [...merged.values()];
}

export function createGitHubResourceIntake(
  run: GitHubCommandRunner = defaultCommandRunner,
): GitHubResourceIntake {
  const cache = new Map<string, { value: CacheValue; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CacheValue>>();
  const viewerLogins = new Map<string, { value: string; expiresAt: number }>();
  const viewerInFlight = new Map<string, Promise<string>>();

  async function getViewerLogin(): Promise<string> {
    const cached = viewerLogins.get("github.com");
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const running = viewerInFlight.get("github.com");
    if (running) return running;
    const request = (async () => {
      try {
        const { stdout } = await run(["api", "user", "--jq", ".login"]);
        const login = stdout.trim();
        if (!login)
          throw new Error("GitHub CLI returned no authenticated login.");
        viewerLogins.set("github.com", {
          value: login,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return login;
      } finally {
        viewerInFlight.delete("github.com");
      }
    })();
    viewerInFlight.set("github.com", request);
    return request;
  }

  async function repositoryResources(
    repository: string,
    state: "open" | "merged" | "closed" = "open",
  ): Promise<GitHubResource[]> {
    const prState =
      state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
    const issueState = state === "closed" ? "closed" : "open";
    const queries: Array<Promise<{ stdout: string; stderr: string }>> = [
      run([
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        prState,
        "--limit",
        "100",
        "--json",
        pullRequestJsonFields,
      ]),
    ];
    if (state !== "merged") {
      queries.push(
        run([
          "issue",
          "list",
          "--repo",
          repository,
          "--state",
          issueState,
          "--limit",
          "100",
          "--json",
          issueJsonFields,
        ]),
      );
    }
    const [pullRequests, issues] = await Promise.all(queries);
    const parse = (text: string) => {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value)
        ? value.flatMap((item) => {
            const itemRecord = asRecord(item);
            return itemRecord ? [itemRecord] : [];
          })
        : [];
    };
    const decorateRepository = (record: Record<string, unknown>) => ({
      ...record,
      repository: { nameWithOwner: repository },
    });
    const prItems = parse(pullRequests.stdout).flatMap((record) => {
      const item = makePullRequest(decorateRepository(record), {
        isMine: false,
        reviewRequestedFromMe: false,
      });
      return item ? [item] : [];
    });
    const issueItems = issues
      ? parse(issues.stdout).flatMap((record) => {
          const item = makeIssue(decorateRepository(record), {
            isMine: false,
            isAssignedToMe: false,
          });
          return item ? [item] : [];
        })
      : [];
    return mergeResources([...prItems, ...issueItems]);
  }

  async function accountResources(
    state: "open" | "merged" | "closed" = "open",
  ): Promise<GitHubResource[]> {
    const viewer = await getViewerLogin();
    const prQualifier =
      state === "open"
        ? "is:open"
        : state === "merged"
          ? "is:merged"
          : "is:closed -is:merged";
    const issueQualifier = state === "closed" ? "is:closed" : "is:open";
    const { stdout } = await run([
      "api",
      "graphql",
      "-f",
      `query=${accountQuery}`,
      "-f",
      `authoredPr=is:pr ${prQualifier} author:${viewer}`,
      "-f",
      `reviewPr=is:pr ${prQualifier} review-requested:${viewer}`,
      "-f",
      state === "merged"
        ? `authoredIssue=is:issue is:closed author:__none__`
        : `authoredIssue=is:issue ${issueQualifier} author:${viewer}`,
      "-f",
      state === "merged"
        ? `assignedIssue=is:issue is:closed assignee:__none__`
        : `assignedIssue=is:issue ${issueQualifier} assignee:${viewer}`,
    ]);
    const root = asRecord(asRecord(JSON.parse(stdout))?.data);
    const nodes = (name: string) => {
      const connection = asRecord(root?.[name]);
      return Array.isArray(connection?.nodes)
        ? connection.nodes.flatMap((item) => {
            const record = asRecord(item);
            return record ? [record] : [];
          })
        : [];
    };
    const prItems = [
      ...nodes("authoredPr").flatMap((record) => {
        const item = makePullRequest(record, {
          isMine: true,
          reviewRequestedFromMe: false,
        });
        return item ? [item] : [];
      }),
      ...nodes("reviewPr").flatMap((record) => {
        const item = makePullRequest(record, {
          isMine: false,
          reviewRequestedFromMe: true,
        });
        return item ? [item] : [];
      }),
    ];
    const issueItems =
      state === "merged"
        ? []
        : [
            ...nodes("authoredIssue").flatMap((record) => {
              const item = makeIssue(record, {
                isMine: true,
                isAssignedToMe: false,
              });
              return item ? [item] : [];
            }),
            ...nodes("assignedIssue").flatMap((record) => {
              const item = makeIssue(record, {
                isMine: false,
                isAssignedToMe: true,
              });
              return item ? [item] : [];
            }),
          ];
    return mergeResources([...prItems, ...issueItems]);
  }

  async function listResources(
    input: z.infer<typeof listResourcesRpc.input>,
  ): Promise<CacheValue> {
    const repository = input.repository?.toLowerCase();
    const state = input.state ?? "open";
    const key = `${input.scope}:${repository ?? "account"}:${state}`;
    const cached = cache.get(key);
    if (!input.forceRefresh && cached && cached.expiresAt > Date.now())
      return cached.value;
    const running = inFlight.get(key);
    if (running) return running;
    const request = (async () => {
      try {
        const resources =
          input.scope === "account"
            ? await accountResources(state)
            : repository
              ? await repositoryResources(repository, state)
              : [];
        const value = {
          resources,
          refreshedAt: new Date().toISOString(),
          warnings: [],
        };
        cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      } catch (error) {
        return {
          resources: [],
          refreshedAt: new Date().toISOString(),
          warnings: [errorWarning(error)],
        };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return request;
  }

  async function refreshResource(
    input: z.infer<typeof refreshResourceRpc.input>,
  ): Promise<z.infer<typeof refreshResourceRpc.output>> {
    const command = input.kind === "pull-request" ? "pr" : "issue";
    const fields =
      input.kind === "pull-request" ? pullRequestJsonFields : issueJsonFields;
    try {
      const { stdout } = await run([
        command,
        "view",
        String(input.number),
        "--repo",
        input.repository,
        "--json",
        fields,
      ]);
      const record = asRecord(JSON.parse(stdout));
      if (!record)
        throw new Error("GitHub returned an invalid resource payload.");
      const decorated = {
        ...record,
        repository: { nameWithOwner: input.repository },
      };
      const resource =
        input.kind === "pull-request"
          ? makePullRequest(decorated, {
              isMine: false,
              reviewRequestedFromMe: false,
            })
          : makeIssue(decorated, { isMine: false, isAssignedToMe: false });
      if (!resource)
        throw new Error("GitHub returned an incomplete resource payload.");
      return { resource };
    } catch (error) {
      throw new Error(errorWarning(error).message);
    }
  }

  return {
    listResources,
    refreshResource,
  };
}

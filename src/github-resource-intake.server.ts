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

export type GitHubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GitHubResourceIntakeOptions = {
  /**
   * Uses GitHub's HTTP API directly when set. `undefined` reads GH_TOKEN or
   * GITHUB_TOKEN from the daemon environment; `null` explicitly uses gh.
   */
  token?: string | null;
  fetch?: GitHubFetch;
  apiUrl?: string;
};

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
type GraphqlResult = { data: Record<string, unknown>; error: string | null };
type ResourceLoad = { resources: GitHubResource[]; warnings: Warning[] };

const execFile = promisify(execFileCallback);
// Keep this slightly shorter than the five-minute client poll interval so a
// scheduled refetch always reaches GitHub rather than extending stale data.
const CACHE_TTL_MS = 4 * 60_000;
const GH_COMMAND_TIMEOUT_MS = 60_000;
const GH_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_CHECK_DETAILS_PER_PULL_REQUEST = 20;
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

const pullRequestSelection = `
number title body url state mergedAt closedAt createdAt updatedAt isDraft headRefName baseRefName mergeable reviewDecision comments { totalCount } author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } statusCheckRollup { state contexts(first: ${MAX_CHECK_DETAILS_PER_PULL_REQUEST}) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } }
`;

const issueSelection = `
number title body url state closedAt createdAt updatedAt author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } milestone { title } comments { totalCount }
`;

const pullRequestSummarySelection = `
number title url state mergedAt closedAt createdAt updatedAt isDraft headRefName baseRefName mergeable reviewDecision comments { totalCount } author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } statusCheckRollup { state }
`;

const issueSummarySelection = `
number title url state closedAt createdAt updatedAt author { login } repository { nameWithOwner } labels(first: 20) { nodes { name } } assignees(first: 20) { nodes { login } } milestone { title } comments { totalCount }
`;

const accountQuery = `
query Workbench($authoredPr: String!, $reviewPr: String!, $authoredIssue: String!, $assignedIssue: String!) {
  authoredPr: search(query: $authoredPr, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${pullRequestSummarySelection} } } }
  reviewPr: search(query: $reviewPr, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${pullRequestSummarySelection} } } }
  authoredIssue: search(query: $authoredIssue, type: ISSUE, first: 100) { nodes { ... on Issue { ${issueSummarySelection} } } }
  assignedIssue: search(query: $assignedIssue, type: ISSUE, first: 100) { nodes { ... on Issue { ${issueSummarySelection} } } }
}`;

const viewerQuery = `query WorkbenchViewer { viewer { login } }`;

const repositoryQuery = `
query WorkbenchRepository($owner: String!, $name: String!, $pullRequestState: PullRequestState!, $issueState: IssueState!, $includeIssues: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [$pullRequestState], first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${pullRequestSummarySelection} } }
    issues(states: [$issueState], first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $includeIssues) { nodes { ${issueSummarySelection} } }
  }
}`;

function resourceQuery(kind: "pull-request" | "issue"): string {
  const field = kind === "pull-request" ? "pullRequest" : "issue";
  const selection =
    kind === "pull-request" ? pullRequestSelection : issueSelection;
  return `
query WorkbenchResource($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    ${field}(number: $number) { ${selection} }
  }
}`;
}

function defaultCommandRunner(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFile("gh", args, {
    // GraphQL can return hundreds of resources. Bound it, but do not discard a
    // valid large response while gh is still parsing its output.
    timeout: GH_COMMAND_TIMEOUT_MS,
    maxBuffer: GH_COMMAND_MAX_BUFFER_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function environmentToken(): string | null {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return token?.trim() || null;
}

function graphqlErrorMessage(value: unknown): string | null {
  const root = asRecord(value);
  const errors = Array.isArray(root?.errors) ? root.errors : [];
  const messages = errors.flatMap((error) => {
    const message = asString(asRecord(error)?.message);
    return message ? [message] : [];
  });
  return messages.length > 0 ? messages.join("\n") : null;
}

function partialDataWarning(error: string): Warning {
  return {
    code: "github-query-failed",
    message: `Some GitHub fields could not be loaded: ${error}`,
  };
}

function splitRepository(repository: string): [string, string] {
  const [owner, name] = repository.split("/", 2);
  if (!owner || !name) throw new Error("GitHub repository must be owner/name.");
  return [owner, name];
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
  if (
    /authentication|not logged in|auth login|bad credentials|HTTP 401/i.test(
      text,
    )
  )
    return {
      code: "gh-not-authenticated",
      message:
        "Authenticate gh or configure GH_TOKEN on the Paseo daemon host before using GitHub Workbench.",
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
    message: text || "GitHub query failed.",
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
  options: GitHubResourceIntakeOptions = {},
): GitHubResourceIntake {
  const cache = new Map<string, { value: CacheValue; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CacheValue>>();
  const viewerLogins = new Map<string, { value: string; expiresAt: number }>();
  const viewerInFlight = new Map<string, Promise<string>>();
  const token =
    options.token === undefined
      ? environmentToken()
      : options.token?.trim() || null;
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? GITHUB_GRAPHQL_URL;

  async function graphql(
    query: string,
    variables: Record<string, string | number | boolean>,
  ): Promise<GraphqlResult> {
    if (!token) {
      const args = ["api", "graphql", "-f", `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
      }
      const { stdout } = await run(args);
      const parsed: unknown = JSON.parse(stdout);
      const error = graphqlErrorMessage(parsed);
      const data = asRecord(asRecord(parsed)?.data);
      // GitHub can return usable partial data when a fine-grained token lacks
      // access to an optional field such as statusCheckRollup. Keep the list
      // available in that case instead of turning the entire workbench blank.
      if (error && !data) throw new Error(error);
      return { data: data ?? {}, error };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(apiUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(
          `GitHub API returned invalid JSON (HTTP ${response.status}).`,
        );
      }
      const error = graphqlErrorMessage(parsed);
      const data = asRecord(asRecord(parsed)?.data);
      if (!response.ok || (error && !data)) {
        throw new Error(
          error ?? `GitHub API request failed with HTTP ${response.status}.`,
        );
      }
      return { data: data ?? {}, error };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getViewerLogin(): Promise<string> {
    const cached = viewerLogins.get("github.com");
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const running = viewerInFlight.get("github.com");
    if (running) return running;
    const request = (async () => {
      try {
        const result = await graphql(viewerQuery, {});
        const login = asString(asRecord(result.data.viewer)?.login) ?? "";
        if (!login)
          throw new Error(
            result.error ?? "GitHub returned no authenticated login.",
          );
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
  ): Promise<ResourceLoad> {
    const [owner, name] = splitRepository(repository);
    const result = await graphql(repositoryQuery, {
      owner,
      name,
      pullRequestState:
        state === "merged" ? "MERGED" : state === "closed" ? "CLOSED" : "OPEN",
      issueState: state === "closed" ? "CLOSED" : "OPEN",
      includeIssues: state !== "merged",
    });
    const record = asRecord(result.data.repository);
    if (!record)
      throw new Error(
        result.error ?? "GitHub returned no data for this repository.",
      );
    const nodes = (field: "pullRequests" | "issues") => {
      const connection = asRecord(record?.[field]);
      return Array.isArray(connection?.nodes)
        ? connection.nodes.flatMap((item) => {
            const resource = asRecord(item);
            return resource ? [resource] : [];
          })
        : [];
    };
    const prItems = nodes("pullRequests").flatMap((item) => {
      const resource = makePullRequest(item, {
        isMine: false,
        reviewRequestedFromMe: false,
      });
      return resource ? [resource] : [];
    });
    const issueItems = nodes("issues").flatMap((item) => {
      const resource = makeIssue(item, {
        isMine: false,
        isAssignedToMe: false,
      });
      return resource ? [resource] : [];
    });
    return {
      resources: mergeResources([...prItems, ...issueItems]),
      warnings: result.error ? [partialDataWarning(result.error)] : [],
    };
  }

  async function accountResources(
    state: "open" | "merged" | "closed" = "open",
  ): Promise<ResourceLoad> {
    const viewer = await getViewerLogin();
    const prQualifier =
      state === "open"
        ? "is:open"
        : state === "merged"
          ? "is:merged"
          : "is:closed -is:merged";
    const issueQualifier = state === "closed" ? "is:closed" : "is:open";
    const result = await graphql(accountQuery, {
      authoredPr: `is:pr ${prQualifier} author:${viewer}`,
      reviewPr: `is:pr ${prQualifier} review-requested:${viewer}`,
      authoredIssue:
        state === "merged"
          ? "is:issue is:closed author:__none__"
          : `is:issue ${issueQualifier} author:${viewer}`,
      assignedIssue:
        state === "merged"
          ? "is:issue is:closed assignee:__none__"
          : `is:issue ${issueQualifier} assignee:${viewer}`,
    });
    const root = result.data;
    const connectionNames = [
      "authoredPr",
      "reviewPr",
      "authoredIssue",
      "assignedIssue",
    ];
    if (!connectionNames.some((name) => asRecord(root[name])))
      throw new Error(result.error ?? "GitHub returned no account resources.");
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
    return {
      resources: mergeResources([...prItems, ...issueItems]),
      warnings: result.error ? [partialDataWarning(result.error)] : [],
    };
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
        const loaded =
          input.scope === "account"
            ? await accountResources(state)
            : repository
              ? await repositoryResources(repository, state)
              : { resources: [], warnings: [] };
        const value = {
          resources: loaded.resources,
          refreshedAt: new Date().toISOString(),
          warnings: loaded.warnings,
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
    try {
      const [owner, name] = splitRepository(input.repository);
      const result = await graphql(resourceQuery(input.kind), {
        owner,
        name,
        number: input.number,
      });
      const record = asRecord(
        asRecord(result.data.repository)?.[
          input.kind === "pull-request" ? "pullRequest" : "issue"
        ],
      );
      if (!record)
        throw new Error(
          result.error ?? "GitHub returned an invalid resource payload.",
        );
      const resource =
        input.kind === "pull-request"
          ? makePullRequest(record, {
              isMine: false,
              reviewRequestedFromMe: false,
            })
          : makeIssue(record, { isMine: false, isAssignedToMe: false });
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

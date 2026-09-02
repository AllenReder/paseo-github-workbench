import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { z } from "zod";
import {
  type ensureResourceWorkspaceRpc,
  issueBranchSlug,
  normalizeGitHubRepository,
  type ProjectCatalogItem,
  resourceKey,
  resourceMatchesWorkspace,
} from "./github-workbench.shared";

export type GitCommandRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export type ResourceWorkspaceProvisioner = {
  listProjects(paseo: PaseoApi): Promise<ProjectCatalogItem[]>;
  ensureWorkspace(
    input: z.infer<typeof ensureResourceWorkspaceRpc.input>,
    paseo: PaseoApi,
  ): Promise<z.infer<typeof ensureResourceWorkspaceRpc.output>>;
};

type ResourceWorkspaceInput = z.infer<typeof ensureResourceWorkspaceRpc.input>;
type ResourceWorkspaceResult = z.infer<
  typeof ensureResourceWorkspaceRpc.output
>;

const execFile = promisify(execFileCallback);

function defaultGitCommandRunner(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFile("git", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function listAllWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const entries: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await paseo.workspaces.list({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...response.entries);
    cursor = response.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return entries;
}

function matchingWorkspace(
  input: ResourceWorkspaceInput,
  workspaces: PaseoWorkspace[],
): PaseoWorkspace | undefined {
  return workspaces
    .filter((workspace) =>
      resourceMatchesWorkspace(input, {
        remoteUrl: workspace.gitRuntime?.remoteUrl ?? null,
        pullRequestNumber: workspace.githubRuntime?.pullRequest?.number,
        worktreeSlug: workspace.worktreeSlug,
        archivingAt: workspace.archivingAt,
      }),
    )
    .sort((left, right) => {
      if (input.kind === "pull-request") {
        const leftExact =
          left.githubRuntime?.pullRequest?.number === input.number;
        const rightExact =
          right.githubRuntime?.pullRequest?.number === input.number;
        if (leftExact !== rightExact) return leftExact ? -1 : 1;
      }
      return (
        (right.activityAt ?? "").localeCompare(left.activityAt ?? "") ||
        left.id.localeCompare(right.id)
      );
    })[0];
}

export function createResourceWorkspaceProvisioner(
  runGit: GitCommandRunner = defaultGitCommandRunner,
): ResourceWorkspaceProvisioner {
  const resourceWorkspaceEnsures = new Map<
    string,
    Promise<ResourceWorkspaceResult>
  >();

  async function listProjects(paseo: PaseoApi): Promise<ProjectCatalogItem[]> {
    const { projects } = await paseo.projects.list();
    const catalog = await Promise.all(
      projects.map(async (project) => {
        try {
          const { stdout } = await runGit([
            "-C",
            project.projectRootPath,
            "remote",
            "get-url",
            "origin",
          ]);
          return {
            projectId: project.projectId,
            displayName: project.projectDisplayName,
            projectRootPath: project.projectRootPath,
            repository: normalizeGitHubRepository(stdout.trim()),
          };
        } catch {
          return {
            projectId: project.projectId,
            displayName: project.projectDisplayName,
            projectRootPath: project.projectRootPath,
            repository: null,
          };
        }
      }),
    );
    return catalog.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.projectId.localeCompare(right.projectId),
    );
  }

  async function ensureWorkspaceOnce(
    input: ResourceWorkspaceInput,
    paseo: PaseoApi,
  ): Promise<ResourceWorkspaceResult> {
    const workspace = matchingWorkspace(input, await listAllWorkspaces(paseo));
    if (workspace)
      return {
        action: "opened",
        workspaceId: workspace.id,
        message: "Opened the existing Paseo Workspace.",
      };

    const localProject = (await listProjects(paseo)).find(
      (project) =>
        project.repository?.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!localProject)
      return {
        action: "local-project-not-found",
        message:
          "This repository is not registered as a local Paseo project, so GitHub Workbench will not clone it.",
      };

    const source =
      input.kind === "pull-request"
        ? {
            kind: "worktree" as const,
            projectId: localProject.projectId,
            action: "checkout" as const,
            checkoutSource: {
              kind: "change_request" as const,
              forge: "github",
              number: input.number,
              projectPath: input.repository,
            },
            worktreeSlug: `pr-${input.number}`,
          }
        : await (async () => {
            const { stdout } = await runGit([
              "-C",
              localProject.projectRootPath,
              "branch",
              "--show-current",
            ]);
            const refName = stdout.trim();
            if (!refName) return null;
            const branchName = issueBranchSlug(input.number, input.title);
            return {
              kind: "worktree" as const,
              projectId: localProject.projectId,
              action: "branch-off" as const,
              refName,
              branchName,
              worktreeSlug: branchName,
            };
          })();
    if (!source)
      return {
        action: "base-branch-unavailable",
        message:
          "The registered local project has no current branch to use as the Issue worktree base.",
      };

    const createdWorkspace = await paseo.workspaces.create({
      title: `${input.kind === "pull-request" ? "PR" : "Issue"} ${input.repository}#${input.number}: ${input.title}`,
      source,
    });
    return {
      action: "created",
      workspaceId: createdWorkspace.id,
      message: "Created a Paseo Workspace.",
    };
  }

  async function ensureWorkspace(
    input: ResourceWorkspaceInput,
    paseo: PaseoApi,
  ): Promise<ResourceWorkspaceResult> {
    const key = resourceKey(input.kind, input.repository, input.number);
    const existing = resourceWorkspaceEnsures.get(key);
    if (existing) return existing;
    const operation = ensureWorkspaceOnce(input, paseo);
    resourceWorkspaceEnsures.set(key, operation);
    operation.then(
      () => resourceWorkspaceEnsures.delete(key),
      () => resourceWorkspaceEnsures.delete(key),
    );
    return operation;
  }

  return {
    listProjects,
    ensureWorkspace,
  };
}

import { describe, expect, it } from "bun:test";
import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { createResourceWorkspaceProvisioner } from "./resource-workspace-provisioner.server";

function createMockPaseo(overrides?: {
  workspaces?: PaseoWorkspace[];
  projects?: {
    projectId: string;
    projectDisplayName: string;
    projectRootPath: string;
  }[];
  createWorkspace?: (input: unknown) => Promise<PaseoWorkspace>;
}): PaseoApi {
  const workspacesList = overrides?.workspaces ?? [];
  const projectsList = overrides?.projects ?? [];
  return {
    workspaces: {
      list: async () => ({
        entries: workspacesList,
        pageInfo: { hasNextPage: false, nextCursor: null },
      }),
      create:
        overrides?.createWorkspace ??
        (async (input: unknown) => {
          const req = input as {
            title?: string;
            source?: { projectId?: string };
          };
          return {
            id: "ws-created-1",
            projectId: req.source?.projectId ?? "proj-1",
            name: req.title ?? "Created Workspace",
            title: req.title ?? "Created Workspace",
            archivingAt: null,
            activityAt: "2026-02-01T00:00:00Z",
            createdAt: "2026-02-01T00:00:00Z",
            updatedAt: "2026-02-01T00:00:00Z",
          } as unknown as PaseoWorkspace;
        }),
    },
    projects: {
      list: async () => ({
        projects: projectsList,
      }),
    },
  } as unknown as PaseoApi;
}

describe("ResourceWorkspaceProvisioner", () => {
  it("opens existing workspace when found and prioritizes exact PR number over newer slug match", async () => {
    const workspaces: PaseoWorkspace[] = [
      {
        id: "ws-slug-match",
        projectId: "proj-1",
        name: "pr-42",
        worktreeSlug: "pr-42",
        gitRuntime: { remoteUrl: "https://github.com/getpaseo/paseo.git" },
        githubRuntime: { pullRequest: { number: 999 } },
        archivingAt: null,
        activityAt: "2026-02-05T00:00:00Z", // newer
      } as unknown as PaseoWorkspace,
      {
        id: "ws-exact-match",
        projectId: "proj-1",
        name: "some-feature",
        worktreeSlug: "random-slug",
        gitRuntime: { remoteUrl: "https://github.com/getpaseo/paseo.git" },
        githubRuntime: { pullRequest: { number: 42 } },
        archivingAt: null,
        activityAt: "2026-02-01T00:00:00Z", // older
      } as unknown as PaseoWorkspace,
    ];

    const paseo = createMockPaseo({ workspaces });
    const provisioner = createResourceWorkspaceProvisioner();

    const result = await provisioner.ensureWorkspace(
      {
        kind: "pull-request",
        repository: "getpaseo/paseo",
        number: 42,
        title: "Test PR",
      },
      paseo,
    );

    expect(result.action).toBe("opened");
    expect(result.workspaceId).toBe("ws-exact-match");
  });

  it("ignores archiving workspaces", async () => {
    const workspaces: PaseoWorkspace[] = [
      {
        id: "ws-archiving",
        projectId: "proj-1",
        name: "pr-42",
        worktreeSlug: "pr-42",
        gitRuntime: { remoteUrl: "https://github.com/getpaseo/paseo.git" },
        githubRuntime: { pullRequest: { number: 42 } },
        archivingAt: "2026-02-01T00:00:00Z",
      } as unknown as PaseoWorkspace,
    ];

    const projects = [
      {
        projectId: "proj-1",
        projectDisplayName: "Paseo",
        projectRootPath: "/path/to/repo",
      },
    ];

    let created = false;
    const paseo = createMockPaseo({
      workspaces,
      projects,
      createWorkspace: async (input: unknown) => {
        const req = input as { title: string; source: { projectId: string } };
        created = true;
        return {
          id: "ws-new",
          projectId: req.source.projectId,
          name: req.title,
        } as unknown as PaseoWorkspace;
      },
    });

    const provisioner = createResourceWorkspaceProvisioner(async () => ({
      stdout: "https://github.com/getpaseo/paseo.git\n",
      stderr: "",
    }));

    const result = await provisioner.ensureWorkspace(
      {
        kind: "pull-request",
        repository: "getpaseo/paseo",
        number: 42,
        title: "Test PR",
      },
      paseo,
    );

    expect(result.action).toBe("created");
    expect(result.workspaceId).toBe("ws-new");
    expect(created).toBe(true);
  });

  it("returns local-project-not-found when no registered project matches the repository", async () => {
    const projects = [
      {
        projectId: "proj-1",
        projectDisplayName: "Other Repo",
        projectRootPath: "/path/to/other",
      },
    ];

    const paseo = createMockPaseo({ projects });
    const provisioner = createResourceWorkspaceProvisioner(async () => ({
      stdout: "https://github.com/other/repo.git\n",
      stderr: "",
    }));

    const result = await provisioner.ensureWorkspace(
      {
        kind: "pull-request",
        repository: "getpaseo/paseo",
        number: 42,
        title: "Test PR",
      },
      paseo,
    );

    expect(result.action).toBe("local-project-not-found");
  });

  it("returns base-branch-unavailable for Issue when git branch --show-current returns empty", async () => {
    const projects = [
      {
        projectId: "proj-1",
        projectDisplayName: "Paseo",
        projectRootPath: "/path/to/repo",
      },
    ];

    const paseo = createMockPaseo({ projects });
    const provisioner = createResourceWorkspaceProvisioner(async (args) => {
      if (args.includes("remote")) {
        return {
          stdout: "https://github.com/getpaseo/paseo.git\n",
          stderr: "",
        };
      }
      if (args.includes("branch")) {
        return { stdout: "\n", stderr: "" }; // empty current branch (detached HEAD)
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await provisioner.ensureWorkspace(
      {
        kind: "issue",
        repository: "getpaseo/paseo",
        number: 101,
        title: "Bug in parser",
      },
      paseo,
    );

    expect(result.action).toBe("base-branch-unavailable");
  });

  it("coalesces concurrent ensureWorkspace calls and clears in-flight entry on rejection", async () => {
    const projects = [
      {
        projectId: "proj-1",
        projectDisplayName: "Paseo",
        projectRootPath: "/path/to/repo",
      },
    ];

    let createCalls = 0;
    const paseo = createMockPaseo({
      projects,
      createWorkspace: async (input: unknown) => {
        const req = input as { title: string; source: { projectId: string } };
        createCalls += 1;
        return {
          id: `ws-${createCalls}`,
          projectId: req.source.projectId,
          name: req.title,
        } as unknown as PaseoWorkspace;
      },
    });

    const provisioner = createResourceWorkspaceProvisioner(async () => ({
      stdout: "https://github.com/getpaseo/paseo.git\n",
      stderr: "",
    }));

    const [res1, res2] = await Promise.all([
      provisioner.ensureWorkspace(
        {
          kind: "pull-request",
          repository: "getpaseo/paseo",
          number: 42,
          title: "Test PR",
        },
        paseo,
      ),
      provisioner.ensureWorkspace(
        {
          kind: "pull-request",
          repository: "getpaseo/paseo",
          number: 42,
          title: "Test PR",
        },
        paseo,
      ),
    ]);

    expect(createCalls).toBe(1);
    expect(res1.workspaceId).toBe(res2.workspaceId);
  });

  it("lists projects and sets repository to null on git remote failure", async () => {
    const projects = [
      {
        projectId: "proj-1",
        projectDisplayName: "Working Project",
        projectRootPath: "/path/to/working",
      },
      {
        projectId: "proj-2",
        projectDisplayName: "Broken Project",
        projectRootPath: "/path/to/broken",
      },
    ];

    const paseo = createMockPaseo({ projects });
    const provisioner = createResourceWorkspaceProvisioner(async (args) => {
      if (args[1] === "/path/to/working") {
        return {
          stdout: "git@github.com:getpaseo/paseo.git\n",
          stderr: "",
        };
      }
      throw new Error("fatal: not a git repository");
    });

    const catalog = await provisioner.listProjects(paseo);
    expect(catalog).toHaveLength(2);
    expect(catalog[0].displayName).toBe("Broken Project");
    expect(catalog[0].repository).toBeNull();
    expect(catalog[1].displayName).toBe("Working Project");
    expect(catalog[1].repository).toBe("getpaseo/paseo");
  });
});

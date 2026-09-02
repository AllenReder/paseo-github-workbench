import type { PluginContext } from "@getpaseo/plugin";
import { GitHubWorkbenchSurface } from "./src/github-workbench.client";
import {
  ensureResourceWorkspace,
  listProjectCatalog,
  listResources,
  refreshResourceRpcHandler,
} from "./src/github-workbench.server";
import {
  ensureResourceWorkspaceRpc,
  listProjectCatalogRpc,
  listResourcesRpc,
  refreshResourceRpc,
} from "./src/github-workbench.shared";
import { ProjectGitHubWorkbenchPanel } from "./src/project-workbench.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(refreshResourceRpc, refreshResourceRpcHandler);
  plugin.handle(listProjectCatalogRpc, listProjectCatalog);
  plugin.handle(listResourcesRpc, listResources);
  plugin.handle(ensureResourceWorkspaceRpc, ensureResourceWorkspace);
  plugin.addSurface("github-workbench", GitHubWorkbenchSurface);
  plugin.addSidebarItem({
    id: "github-workbench",
    title: "GitHub Workbench",
    icon: "GitPullRequest",
    surface: "github-workbench",
  });
  plugin.addWorkspacePanel({
    id: "project-github-workbench",
    title: "GitHub Workbench",
    icon: "CircleDot",
    context: "workspace",
    Component: ProjectGitHubWorkbenchPanel,
  });
  plugin.addCommandCenterItem({
    id: "open-github-workbench",
    title: "Open GitHub Workbench",
    icon: "GitPullRequest",
    keywords: ["github", "pull request", "issue"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("github-workbench");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-project-github-workbench",
    title: "Open project GitHub Workbench",
    icon: "CircleDot",
    keywords: ["github", "pull request", "issue"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("project-github-workbench");
    },
  });
  return () => {};
}

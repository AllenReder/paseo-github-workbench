import {
  type PluginWorkspacePanelProps,
  usePaseo,
  useWorkspace,
} from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { normalizeGitHubRepository } from "./github-workbench.shared";
import { I18nProvider, useTranslation } from "./i18n/context";
import { useProjectRepositories, Workbench } from "./workbench-ui.client";

function ProjectGitHubWorkbenchPanelInner(props: PluginWorkspacePanelProps) {
  const { t } = useTranslation();
  const paseo = usePaseo();
  const workspace = useWorkspace(props.workspaceId, (item) => ({
    projectId: item.projectId,
  }));
  const currentWorkspaceQuery = useQuery({
    queryKey: [
      "github-workbench",
      props.host.id,
      "current-workspace",
      props.workspaceId,
    ],
    enabled: Boolean(props.workspaceId),
    staleTime: 4 * 60_000,
    queryFn: async () => {
      const response = await paseo.workspaces.list({
        filter: { idPrefix: props.workspaceId },
        page: { limit: 20 },
      });
      return (
        response.entries.find(
          (workspace) => workspace.id === props.workspaceId,
        ) ?? null
      );
    },
  });
  // The plugin workspace snapshot intentionally omits git runtime details, so
  // refresh only this workspace for its remote. This runs in parallel with the
  // project-wide repository query and avoids waiting for a global scan.
  const currentRepository = normalizeGitHubRepository(
    currentWorkspaceQuery.data?.gitRuntime?.remoteUrl,
  );
  const repositories = useProjectRepositories(
    workspace?.projectId ?? null,
    props.host.id,
    currentRepository,
  );
  const [repository, setRepository] = useState<string | null>(null);
  const selectedRepository = repository ?? repositories[0] ?? null;

  useEffect(() => {
    if (
      selectedRepository &&
      !repositories.some(
        (item) => item.toLowerCase() === selectedRepository.toLowerCase(),
      )
    )
      setRepository(null);
  }, [repositories, selectedRepository]);

  if (!workspace || !selectedRepository) {
    return (
      <View
        style={{
          backgroundColor: props.theme.colors.surface0,
          flex: 1,
          padding: props.layout.compact ? 12 : 20,
        }}
      >
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          {t("workbench.noWorkspaceRepo")}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ backgroundColor: props.theme.colors.surface0, flex: 1 }}>
      <Workbench
        {...props}
        scope={{ scope: "repository", repository: selectedRepository }}
      />
    </View>
  );
}

export function ProjectGitHubWorkbenchPanel(props: PluginWorkspacePanelProps) {
  return (
    <I18nProvider>
      <ProjectGitHubWorkbenchPanelInner {...props} />
    </I18nProvider>
  );
}

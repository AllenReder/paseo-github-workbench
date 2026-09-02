import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { I18nProvider, useTranslation } from "./i18n/context";
import { useProjectRepositories, Workbench } from "./workbench-ui.client";

function ProjectGitHubWorkbenchPanelInner(props: PluginWorkspacePanelProps) {
  const { t } = useTranslation();
  const workspace = useWorkspace(props.workspaceId, (item) => ({
    projectId: item.projectId,
  }));
  const repositories = useProjectRepositories(
    workspace?.projectId ?? null,
    props.host.id,
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

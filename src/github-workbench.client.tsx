import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listProjectCatalogRpc } from "./github-workbench.shared";
import { I18nProvider, useTranslation } from "./i18n/context";
import { GitHubDiagnosticsStatus, Workbench } from "./workbench-ui.client";

function GitHubWorkbenchSurfaceInner(props: PluginSurfaceProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"account" | "projects">("account");
  const [projectId, setProjectId] = useState<string | null>(null);
  const listProjectCatalog = useRpc(listProjectCatalogRpc);
  const catalog = useQuery({
    queryKey: ["github-workbench", props.host.id, "project-catalog"],
    queryFn: () => listProjectCatalog({}),
    staleTime: 30_000,
  });
  const projects = catalog.data?.projects ?? [];
  const selectedProject =
    projects.find((project) => project.projectId === projectId) ?? projects[0];

  return (
    <View style={{ backgroundColor: props.theme.colors.surface0, flex: 1 }}>
      <View
        style={{
          alignItems: "center",
          backgroundColor: props.theme.colors.surface1,
          borderColor: props.theme.colors.border,
          borderBottomWidth: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          minHeight: 42,
          paddingHorizontal: props.layout.compact ? 12 : 20,
        }}
      >
        <View style={{ flexDirection: "row" }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab("account")}
          >
            <Text
              style={{
                borderBottomColor:
                  tab === "account" ? props.theme.colors.accent : "transparent",
                borderBottomWidth: 2,
                color:
                  tab === "account"
                    ? props.theme.colors.foreground
                    : props.theme.colors.foregroundMuted,
                fontWeight: "700",
                paddingBottom: 10,
                paddingHorizontal: 12,
                paddingTop: 12,
              }}
            >
              {t("navigation.tabs.account")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab("projects")}
          >
            <Text
              style={{
                borderBottomColor:
                  tab === "projects"
                    ? props.theme.colors.accent
                    : "transparent",
                borderBottomWidth: 2,
                color:
                  tab === "projects"
                    ? props.theme.colors.foreground
                    : props.theme.colors.foregroundMuted,
                fontWeight: "700",
                paddingBottom: 10,
                paddingHorizontal: 12,
                paddingTop: 12,
              }}
            >
              {t("navigation.tabs.projects")}
            </Text>
          </Pressable>
        </View>
        <GitHubDiagnosticsStatus
          compact={props.layout.compact}
          hostId={props.host.id}
          theme={props.theme}
        />
      </View>
      {tab === "projects" ? (
        <View
          style={{
            backgroundColor: props.theme.colors.surface1,
            gap: 8,
            padding: props.layout.compact ? 12 : 20,
          }}
        >
          <Text
            style={{ color: props.theme.colors.foregroundMuted, fontSize: 13 }}
          >
            {props.host.label}
            {" · "}
            {selectedProject
              ? `${selectedProject.displayName} · ${selectedProject.repository ?? "No GitHub remote"}`
              : catalog.isLoading
                ? t("navigation.loadingProjects")
                : ""}
          </Text>
          <ScrollView horizontal contentContainerStyle={{ gap: 10 }}>
            {projects.map((project) => {
              const selected = selectedProject?.projectId === project.projectId;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={project.projectId}
                  onPress={() => setProjectId(project.projectId)}
                  style={{
                    backgroundColor: selected
                      ? props.theme.colors.surface2
                      : props.theme.colors.surface0,
                    borderColor: selected
                      ? props.theme.colors.accent
                      : props.theme.colors.border,
                    borderRadius: 8,
                    borderWidth: 1,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  <Text
                    style={{
                      color: selected
                        ? props.theme.colors.foreground
                        : props.theme.colors.foregroundMuted,
                      fontWeight: selected ? "700" : "400",
                    }}
                  >
                    {project.displayName}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <Workbench
        {...props}
        scope={
          tab === "account"
            ? { scope: "account" }
            : selectedProject?.repository
              ? {
                  scope: "repository",
                  repository: selectedProject.repository,
                }
              : null
        }
        showDiagnostics={false}
      />
    </View>
  );
}

export function GitHubWorkbenchSurface(props: PluginSurfaceProps) {
  return (
    <I18nProvider>
      <GitHubWorkbenchSurfaceInner {...props} />
    </I18nProvider>
  );
}

import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { I18nProvider } from "./i18n/context";
import { Workbench } from "./workbench-ui.client";

function GitHubWorkbenchSurfaceInner(props: PluginSurfaceProps) {
  return (
    <Workbench {...props} scope={{ scope: "account" }} selectableProjects />
  );
}

export function GitHubWorkbenchSurface(props: PluginSurfaceProps) {
  return (
    <I18nProvider>
      <GitHubWorkbenchSurfaceInner {...props} />
    </I18nProvider>
  );
}

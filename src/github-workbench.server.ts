import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import { createGitHubResourceIntake } from "./github-resource-intake.server";
import type {
  diagnosticsRpc,
  ensureResourceWorkspaceRpc,
  listProjectCatalogRpc,
  listResourcesRpc,
  refreshResourceRpc,
} from "./github-workbench.shared";
import { createResourceWorkspaceProvisioner } from "./resource-workspace-provisioner.server";

const intake = createGitHubResourceIntake();
const provisioner = createResourceWorkspaceProvisioner();

export async function ensureResourceWorkspace(
  input: z.infer<typeof ensureResourceWorkspaceRpc.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.infer<typeof ensureResourceWorkspaceRpc.output>> {
  return provisioner.ensureWorkspace(input, paseo);
}

export async function listProjectCatalog(
  _input: z.infer<typeof listProjectCatalogRpc.input>,
  { paseo }: PluginHandlerContext,
): Promise<z.infer<typeof listProjectCatalogRpc.output>> {
  return { projects: await provisioner.listProjects(paseo) };
}

export async function diagnosticsRpcHandler(
  input: z.infer<typeof diagnosticsRpc.input>,
): Promise<z.infer<typeof diagnosticsRpc.output>> {
  return intake.diagnostics(input);
}

export async function refreshResourceRpcHandler(
  input: z.infer<typeof refreshResourceRpc.input>,
  _context: PluginHandlerContext,
): Promise<z.infer<typeof refreshResourceRpc.output>> {
  return intake.refreshResource(input);
}

export async function listResources(
  input: z.infer<typeof listResourcesRpc.input>,
): Promise<z.infer<typeof listResourcesRpc.output>> {
  return intake.listResources(input);
}

import { join, resolve } from "node:path";
import {
  isProviderName,
  PROVIDER_NAMES,
} from "../core/provider-definition.js";
import type { AppConfig } from "../types/config.js";
import type { ProviderName } from "../types/provider.js";
import { expandHome, homeDir } from "./paths.js";

export type ProviderDataRootSource = "custom" | "environment" | "default";

export interface ResolvedProviderDataRoot {
  provider: ProviderName;
  label: string;
  /** Where the host keeps its session records. */
  root: string;
  /**
   * Where the host loads our capture hook from. Equal to `root` for every host
   * that keeps sessions and configuration in one directory, which is why
   * redirecting such a host's root also moves where its hook is installed.
   */
  hookRoot: string;
  source: ProviderDataRootSource;
  environmentVariable: string;
}

/**
 * How one host directory is located.
 *
 * Two conventions exist among the supported hosts, so the shape carries both:
 * a host either names the directory outright through its own variable
 * (`CLAUDE_CONFIG_DIR`), or nests a fixed directory name inside an XDG base
 * (`XDG_DATA_HOME/opencode`). `rootVariable` covers the first, `baseVariable`
 * plus `baseDirectory` the second.
 */
interface ProviderDirectory {
  rootVariable?: string;
  baseVariable?: string;
  baseDirectory?: string;
  directory: string;
}

interface ProviderDataRootDefinition {
  label: string;
  /** Session records — the axis a custom config root and the environment override. */
  data: ProviderDirectory;
  /**
   * Set only by a host that loads hooks from somewhere other than its data
   * root. Left unset, the hook root follows the resolved data root, including
   * any override: a host told to keep its state elsewhere reads its hooks from
   * there too, so installing them anywhere else would install them where the
   * host never looks.
   */
  hook?: ProviderDirectory;
}

// Annotated rather than `satisfies`: the optional hook axis has to keep its
// declared type, and an annotated Record still fails to compile the moment a
// provider name is added without an entry here.
const DEFINITIONS: Record<ProviderName, ProviderDataRootDefinition> = {
  claude: {
    label: "Claude Code",
    data: { rootVariable: "CLAUDE_CONFIG_DIR", directory: ".claude" },
  },
  codex: {
    label: "Codex",
    data: { rootVariable: "CODEX_HOME", directory: ".codex" },
  },
  copilot: {
    label: "Copilot CLI",
    data: { rootVariable: "COPILOT_HOME", directory: ".copilot" },
  },
  // opencode is the one host that splits the two, and it follows the XDG base
  // convention on every platform, Windows included: verified against opencode
  // 1.18.19, whose `debug paths` reports ~/.local/share/opencode and
  // ~/.config/opencode on Windows 11. It has no variable naming either
  // directory outright, so only the XDG bases can move them.
  opencode: {
    label: "opencode",
    data: {
      baseVariable: "XDG_DATA_HOME",
      baseDirectory: join(".local", "share"),
      directory: "opencode",
    },
    hook: {
      baseVariable: "XDG_CONFIG_HOME",
      baseDirectory: ".config",
      directory: join("opencode", "plugin"),
    },
  },
};

export function resolveProviderDataRoot(
  provider: ProviderName,
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): ResolvedProviderDataRoot {
  if (!isProviderName(provider)) {
    throw new Error(`Unsupported provider: ${String(provider)}`);
  }
  const definition = DEFINITIONS[provider];

  const custom = config.providerDataRoots?.[provider]?.trim();
  const fromEnvironment = directoryFromEnvironment(definition.data, environment);
  const value = custom || fromEnvironment || directoryPath(definition.data, environment, home);
  const source: ProviderDataRootSource = custom
    ? "custom"
    : fromEnvironment
      ? "environment"
      : "default";
  const root = resolve(expandHome(value));

  return {
    provider,
    label: definition.label,
    root,
    hookRoot: definition.hook
      ? resolve(expandHome(directoryPath(definition.hook, environment, home)))
      : root,
    source,
    environmentVariable: environmentVariableName(definition.data),
  };
}

export function resolveProviderDataRoots(
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): ResolvedProviderDataRoot[] {
  return PROVIDER_NAMES.map((provider) =>
    resolveProviderDataRoot(provider, config, environment, home)
  );
}

/** The variable a user would set to move this directory, for settings copy. */
function environmentVariableName(directory: ProviderDirectory): string {
  return directory.rootVariable || directory.baseVariable || "";
}

/** The value of the host's own root variable, when it declares one and it is set. */
function directoryFromEnvironment(
  directory: ProviderDirectory,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (!directory.rootVariable) return undefined;
  return environment[directory.rootVariable]?.trim() || undefined;
}

function directoryPath(
  directory: ProviderDirectory,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  const named = directoryFromEnvironment(directory, environment);
  if (named) return named;
  const base = directory.baseVariable
    ? environment[directory.baseVariable]?.trim()
    : undefined;
  return join(
    base || join(home, directory.baseDirectory || ""),
    directory.directory,
  );
}

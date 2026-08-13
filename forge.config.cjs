const path = require("node:path");
const { readdir, rm } = require("node:fs/promises");

const helperName = process.platform === "win32"
  ? "agent-usage-stat-helper.exe"
  : "agent-usage-stat-helper";
const artifactRoot = path.join(__dirname, "dist");
const iconRoot = path.join(artifactRoot, "icons");
const forgeOutDir = path.resolve(
  __dirname,
  process.env.AGENT_USAGE_STAT_FORGE_OUT || "dist/forge",
);
const forgeOutRelative = path.relative(artifactRoot, forgeOutDir);
if (
  !forgeOutRelative ||
  forgeOutRelative.startsWith("..") ||
  path.isAbsolute(forgeOutRelative) ||
  forgeOutRelative.includes(path.sep)
) {
  throw new Error("Forge output must be one directory directly under dist/");
}
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const macSigningEnabled = process.env.APPLE_SIGNING_ENABLED === "1";
const macNotarizationEnabled = Boolean(
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID,
);

module.exports = {
  outDir: forgeOutDir,
  packagerConfig: {
    asar: true,
    executableName: "Agent Usage Stat",
    icon: path.join(
      __dirname,
      "dist",
      "icons",
      process.platform === "darwin" ? "icon.icns" : "icon.ico",
    ),
    extraResource: [
      path.join(artifactRoot, "helper", helperName),
      iconRoot,
    ],
    ...(process.platform === "darwin" && macSigningEnabled
      ? { osxSign: {} }
      : {}),
    ...(process.platform === "darwin" && macNotarizationEnabled
      ? {
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
      }
      : {}),
    ignore(file) {
      if (!file) return false;
      if (/^\/dist\/(?:helper|icons|forge|release|desktop-smoke-)(?:\/|$)/.test(file)) {
        return true;
      }
      const included =
        /^\/(dist|node_modules)(\/|$)/.test(file) ||
        /^\/package\.json$/.test(file);
      return !included;
    },
  },
  rebuildConfig: {},
  hooks: {
    async postMake() {
      const entries = await readdir(artifactRoot, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.name !== forgeOutRelative)
        .map((entry) => rm(path.join(artifactRoot, entry.name), {
          recursive: true,
          force: true,
        })));

      const forgeEntries = await readdir(forgeOutDir, { withFileTypes: true });
      await Promise.all(forgeEntries
        .filter((entry) => entry.name !== "make")
        .map((entry) => rm(path.join(forgeOutDir, entry.name), {
          recursive: true,
          force: true,
        })));
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "AgentUsageStat",
        exe: "Agent Usage Stat.exe",
        setupExe: "Agent-Usage-Stat-Setup.exe",
        setupIcon: path.join(iconRoot, "icon.ico"),
        loadingGif: path.join(iconRoot, "install-loading.gif"),
        ...(windowsCertificateFile
          ? {
            certificateFile: windowsCertificateFile,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
          }
          : {}),
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32", "darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
    },
  ],
};

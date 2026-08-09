const path = require("node:path");

const helperName = process.platform === "win32"
  ? "agent-usage-stat-helper.exe"
  : "agent-usage-stat-helper";
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const macSigningEnabled = process.env.APPLE_SIGNING_ENABLED === "1";
const macNotarizationEnabled = Boolean(
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID,
);

module.exports = {
  outDir: process.env.AGENT_USAGE_STAT_FORGE_OUT || "out/desktop",
  packagerConfig: {
    asar: true,
    executableName: "Agent Usage Stat",
    icon: path.join(
      __dirname,
      "assets",
      process.platform === "darwin" ? "icon.icns" : "icon.ico",
    ),
    extraResource: [path.join(__dirname, "build", "helper", helperName)],
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
      const included =
        /^\/(dist|node_modules)(\/|$)/.test(file) ||
        /^\/package\.json$/.test(file) ||
        /^\/assets(?:$|\/(?:icon|logo)\.png$)/.test(file) ||
        /^\/portal(?:$|\/scripts(?:\/|$))/.test(file);
      return !included;
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "AgentUsageStat",
        exe: "Agent Usage Stat.exe",
        setupExe: "Agent-Usage-Stat-Setup.exe",
        setupIcon: path.join(__dirname, "assets", "icon.ico"),
        loadingGif: path.join(__dirname, "assets", "install-loading.gif"),
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

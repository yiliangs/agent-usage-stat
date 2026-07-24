import { execFile } from "child_process";
import { dirname } from "path";
import { promisify } from "util";
import chalk from "chalk";
import { hookExecutablePaths } from "../integrations/hook-command.js";

const execFileAsync = promisify(execFile);
const TASK_NAME = "Agent Usage Stat Portal";
const DEFAULT_PORT = 4179;

export type PortalAutostartAction = "enable" | "disable" | "status";

export interface PortalAutostartOptions {
  port?: string;
}

export class PortalAutostartCommand {
  async execute(
    actionValue: string,
    options: PortalAutostartOptions = {},
  ): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Portal autostart currently supports Windows only.");
    }

    const action = this.parseAction(actionValue);
    const port = this.parsePort(options.port);

    switch (action) {
      case "enable":
        await this.enable(port);
        return;
      case "disable":
        await this.disable();
        return;
      case "status":
        await this.status();
    }
  }

  private async enable(port: number): Promise<void> {
    const cliPath = hookExecutablePaths().windowsBin;
    await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        portalTaskScript(process.execPath, cliPath, port),
      ],
      { windowsHide: true },
    );
    console.log(
      chalk.green(
        `Portal login startup enabled at http://127.0.0.1:${port}`,
      ),
    );
  }

  private async disable(): Promise<void> {
    if (!(await this.isInstalled())) {
      console.log(chalk.gray("Portal login startup is already disabled."));
      return;
    }
    await execFileAsync("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], {
      windowsHide: true,
    });
    console.log(chalk.green("Portal login startup disabled."));
  }

  private async status(): Promise<void> {
    console.log(
      (await this.isInstalled())
        ? chalk.green("Portal login startup is enabled.")
        : chalk.gray("Portal login startup is disabled."),
    );
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await execFileAsync("schtasks.exe", ["/Query", "/TN", TASK_NAME], {
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  private parseAction(value: string): PortalAutostartAction {
    if (value === "enable" || value === "disable" || value === "status") {
      return value;
    }
    throw new Error(`Unsupported portal action: ${value}. Choose enable, disable, or status.`);
  }

  private parsePort(value?: string): number {
    const port = Number(value || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${value}`);
    }
    return port;
  }
}

export function portalTaskScript(
  nodePath: string,
  cliPath: string,
  port = DEFAULT_PORT,
): string {
  const taskName = quotePowerShell(TASK_NAME);
  const executable = quotePowerShell(nodePath);
  const argumentsValue = quotePowerShell(
    `"${cliPath}" portal --no-open --port ${port}`,
  );
  const workingDirectory = quotePowerShell(dirname(cliPath));
  return [
    `$action = New-ScheduledTaskAction -Execute ${executable} -Argument ${argumentsValue} -WorkingDirectory ${workingDirectory}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    `Register-ScheduledTask -TaskName ${taskName} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${taskName}`,
  ].join("; ");
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

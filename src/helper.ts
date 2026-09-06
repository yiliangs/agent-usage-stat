#!/usr/bin/env node

import { isSea } from "node:sea";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Only the detach shim is imported eagerly. It is the hot path, it pulls nothing
// but node builtins, and AGENTS.md requires this file stay import-light. Every
// other command reaches the full provider graph through chalk, ora, and
// capture-run, so a static import here would load all of it on every hook
// invocation just to dispatch to the shim and exit.
import { runDetachShim } from "./commands/detach-shim.js";

declare const __APP_VERSION__: string;

const appVersion = typeof __APP_VERSION__ === "string"
  ? __APP_VERSION__
  : JSON.parse(
    readFileSync(resolve(dirname(process.argv[1]), "..", "package.json"), "utf8"),
  ).version as string;
const args = process.argv.slice(2);

main(args).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[Agent Usage Stat] ${message}\n`);
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const [command = "probe", ...commandArgs] = argv;

  switch (command) {
    case "capture":
      await capture(commandArgs);
      return;
    case "run":
      await run(commandArgs);
      return;
    case "sync": {
      const { SyncCommand } = await import("./commands/sync.js");
      await new SyncCommand().execute({ quiet: hasFlag(commandArgs, "--quiet") });
    }
      return;
    case "setup": {
      const { SetupCommand } = await import("./commands/setup.js");
      await new SetupCommand().execute({
        dataRoot: optionValue(commandArgs, "--data-root"),
        terminalMessage: !hasFlag(commandArgs, "--no-terminal-message"),
        configureTerminal: !hasFlag(commandArgs, "--skip-terminal-config"),
        migrateTerminal: hasFlag(commandArgs, "--migrate-terminal-wrappers"),
        uninstall: hasFlag(commandArgs, "--uninstall"),
      });
    }
      return;
    case "config": {
      const { ConfigCommand } = await import("./commands/config.js");
      await new ConfigCommand().execute({
        show: hasFlag(commandArgs, "--show"),
        set: optionValue(commandArgs, "--set"),
        reset: hasFlag(commandArgs, "--reset"),
      });
    }
      return;
    case "--version":
    case "version":
      process.stdout.write(`${appVersion}\n`);
      return;
    case "probe":
      process.stdout.write(
        `${JSON.stringify({
          application: "Agent Usage Stat",
          version: appVersion,
          runtime: isSea() ? "standalone" : "node",
          platform: process.platform,
          arch: process.arch,
        })}\n`,
      );
      return;
    default:
      throw new Error(`Unknown helper command: ${command}`);
  }
}

async function capture(argv: string[]): Promise<void> {
  const quiet = hasFlag(argv, "--quiet");
  if (hasFlag(argv, "--detach")) {
    runDetachShim({
      quiet,
      workerArgsPrefix: isSea() ? [] : [process.argv[1]],
    });
    return;
  }

  const { CaptureCommand } = await import("./commands/capture.js");
  await new CaptureCommand().execute({
    session: optionValue(argv, "--session"),
    inputFile: optionValue(argv, "--input-file"),
    quiet,
  });
}

async function run(argv: string[]): Promise<void> {
  const [agent, ...agentArgs] = argv;
  if (!agent) throw new Error("Missing agent command.");
  const forwarded = agentArgs[0] === "--" ? agentArgs.slice(1) : agentArgs;
  const { RunCommand } = await import("./commands/run.js");
  process.exitCode = await new RunCommand().execute(agent, forwarded);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

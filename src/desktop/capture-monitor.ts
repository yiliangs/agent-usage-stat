import type { CaptureStrategy } from "../types/config.js";
import type { CaptureHealth } from "../utils/capture-health.js";
import type { HookConfigurationStatus } from "../integrations/hook-status.js";

export type CaptureMonitorStatus =
  | "off"
  | "not_detected"
  | "needs_attention"
  | "unverified"
  | "observed";

export type CaptureMonitorReason =
  | "batch_capture"
  | "agent_not_detected"
  | "hook_missing"
  | "hooks_disabled"
  | "settings_invalid"
  | "last_attempt_failed"
  | "awaiting_first_attempt"
  | "hook_observed";

export interface CaptureMonitor {
  status: CaptureMonitorStatus;
  reason: CaptureMonitorReason;
  observation: CaptureHealth | null;
}

export function captureMonitor(
  strategy: CaptureStrategy,
  available: boolean,
  configuration: HookConfigurationStatus,
  observation: CaptureHealth | null,
): CaptureMonitor {
  if (strategy === "batch") {
    return { status: "off", reason: "batch_capture", observation };
  }
  if (!available) {
    return {
      status: "not_detected",
      reason: "agent_not_detected",
      observation,
    };
  }
  if (configuration !== "configured") {
    return {
      status: "needs_attention",
      reason: configurationReason(configuration),
      observation,
    };
  }
  if (!observation) {
    return {
      status: "unverified",
      reason: "awaiting_first_attempt",
      observation: null,
    };
  }
  if (observation.lastAttemptStatus === "failed") {
    return {
      status: "needs_attention",
      reason: "last_attempt_failed",
      observation,
    };
  }
  return { status: "observed", reason: "hook_observed", observation };
}

function configurationReason(
  status: Exclude<HookConfigurationStatus, "configured">,
): CaptureMonitorReason {
  if (status === "disabled") return "hooks_disabled";
  if (status === "invalid") return "settings_invalid";
  return "hook_missing";
}

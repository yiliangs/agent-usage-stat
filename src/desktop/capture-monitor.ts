import type { CaptureStrategy } from "../types/config.js";
import type { CaptureHealth } from "../utils/capture-health.js";
import type { HookConfigurationStatus } from "../integrations/hook-status.js";

/**
 * Severity, not cause. `needs_attention` is the only tier that asks the user
 * for something; `warning` covers every configured-but-imperfect state that
 * resolves on its own, and `reason` says which one it is.
 */
export type CaptureMonitorStatus =
  | "off"
  | "not_detected"
  | "needs_attention"
  | "warning"
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
  /**
   * True when running Repair setup resolves this exact state: the hook is
   * missing, or the unreadable hook file is application-owned and a reinstall
   * rewrites it. Disabled hooks and unreadable agent-owned files need a user
   * edit, and a recorded delivery failure clears only on the next successful
   * capture, so no button can fix those.
   */
  repairable: boolean;
  observation: CaptureHealth | null;
}

export function captureMonitor(
  strategy: CaptureStrategy,
  available: boolean,
  configuration: HookConfigurationStatus,
  observation: CaptureHealth | null,
  ownsHookFile = false,
): CaptureMonitor {
  if (strategy === "batch") {
    return { status: "off", reason: "batch_capture", repairable: false, observation };
  }
  if (!available) {
    return {
      status: "not_detected",
      reason: "agent_not_detected",
      repairable: false,
      observation,
    };
  }
  if (configuration !== "configured") {
    const reason = configurationReason(configuration);
    return {
      status: "needs_attention",
      reason,
      repairable: reason === "hook_missing" ||
        (reason === "settings_invalid" && ownsHookFile),
      observation,
    };
  }
  if (!observation) {
    return {
      status: "warning",
      reason: "awaiting_first_attempt",
      repairable: false,
      observation: null,
    };
  }
  // A failed attempt clears itself on the next successful checkpoint and app
  // sync still reconciles the usage, so it warns rather than demanding a fix.
  if (observation.lastAttemptStatus === "failed") {
    return {
      status: "warning",
      reason: "last_attempt_failed",
      repairable: false,
      observation,
    };
  }
  return { status: "observed", reason: "hook_observed", repairable: false, observation };
}

function configurationReason(
  status: Exclude<HookConfigurationStatus, "configured">,
): CaptureMonitorReason {
  if (status === "disabled") return "hooks_disabled";
  if (status === "invalid") return "settings_invalid";
  return "hook_missing";
}

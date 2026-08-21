import type { CaptureStrategy } from "../types/config.js";
import type { SetupQuestion } from "./setup-question.js";

export function capturePolicyPrompt(): SetupQuestion<CaptureStrategy> {
  return {
    message: "How should usage be captured?",
    facts: [],
    detail: [
      "Continuous capture (recommended) uses agent hooks to checkpoint usage " +
      "while you work. Hooks are best effort, so Agent Usage Stat also " +
      "reconciles transcripts whenever the application opens and when you " +
      "choose Sync now.",
      "Batch sync installs no hooks. Sessions deleted by an agent before the " +
      "next application sync cannot be recovered.",
    ],
    options: [
      { value: "continuous", label: "Use Continuous Capture" },
      { value: "batch", label: "Use Batch Sync" },
    ],
  };
}

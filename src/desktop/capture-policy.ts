export interface CapturePolicyPrompt {
  message: string;
  detail: string;
  buttons: [string, string];
}

export function capturePolicyPrompt(): CapturePolicyPrompt {
  return {
    message: "How should usage be captured?",
    detail:
      "Continuous capture (recommended) uses agent hooks to checkpoint usage " +
      "while you work. Hooks are best effort, so Agent Usage Stat also " +
      "reconciles transcripts whenever the application opens and when you " +
      "choose Sync now.\n\n" +
      "Batch sync installs no hooks. Sessions deleted by an agent before the " +
      "next application sync cannot be recovered.",
    buttons: ["Use Continuous Capture", "Use Batch Sync"],
  };
}

export interface CaptureModePrompt {
  message: string;
  detail: string;
  buttons: [string, string];
}

export function captureModePrompt(): CaptureModePrompt {
  return {
    message: "How should usage be captured?",
    detail:
      "Automatic capture (recommended) records completed sessions even while " +
      "Agent Usage Stat is closed. It installs hooks in detected agents.\n\n" +
      "Import when the app opens installs no hooks. Sessions deleted by an " +
      "agent before the next import cannot be recovered.",
    buttons: ["Use Automatic Capture", "Import When App Opens"],
  };
}

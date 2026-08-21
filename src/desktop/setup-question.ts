/**
 * The one shape every setup decision takes, independent of where it is drawn.
 * The first-run window renders it inline; the dashboard's native dialog
 * renders the same object through `setupQuestionDetail`.
 */
export interface SetupOption<Value extends string = string> {
  value: Value;
  label: string;
}

/** A labelled path or value the question is about, shown above its prose. */
export interface SetupFact {
  label: string;
  value: string;
}

export interface SetupToggle {
  label: string;
  checked: boolean;
}

export interface SetupQuestion<Value extends string = string> {
  message: string;
  facts: readonly SetupFact[];
  detail: readonly string[];
  options: readonly SetupOption<Value>[];
  toggle?: SetupToggle;
}

export interface SetupAnswer<Value extends string = string> {
  value: Value;
  toggled: boolean;
}

export interface SetupNotice {
  tone: "info" | "warning" | "error";
  title: string;
  message: string;
  detail: string;
}

/** Delivers a one-way setup message on whichever surface is in front. */
export type SetupNotifier = (notice: SetupNotice) => Promise<void>;

/** Flattens a question into the single detail string a native dialog takes. */
export function setupQuestionDetail(question: SetupQuestion): string {
  return [
    ...question.facts.map((fact) => `${fact.label}:\n${fact.value}`),
    ...question.detail,
  ].join("\n\n");
}

/** Resolves a native dialog's button index back to the option it stands for. */
export function setupAnswerAt<Value extends string>(
  question: SetupQuestion<Value>,
  index: number,
  toggled: boolean,
): SetupAnswer<Value> | null {
  const option = question.options[index];
  return option ? { value: option.value, toggled } : null;
}

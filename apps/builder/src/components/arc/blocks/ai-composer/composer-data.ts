export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const effortLabel: Record<Effort, string> = { low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };

export type ModelMarkId = "claude" | "openai" | "gemini";

export interface ComposerModel {
  id: string;
  /** Full name in the menu, for example "Claude Opus 5.5". */
  name: string;
  /** Short name on the chip, for example "Opus 5.5". */
  short: string;
  /** One short line under the name. */
  note: string;
  mark: ModelMarkId;
  defaultEffort: Effort;
}

export const sampleModels: ComposerModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", short: "Opus 5.5", note: "Flagship for complex work", mark: "claude", defaultEffort: "medium" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", short: "Sonnet 5.5", note: "Everyday coding and agents", mark: "claude", defaultEffort: "high" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", short: "Haiku 5.5", note: "Fastest for quick answers", mark: "claude", defaultEffort: "medium" },
  { id: "gpt-6-1-sol", name: "GPT-6.1 Sol", short: "GPT-6.1 Sol", note: "OpenAI, released Sep 29", mark: "openai", defaultEffort: "medium" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", short: "Gemini 4", note: "Google, 2M context", mark: "gemini", defaultEffort: "medium" },
];

export interface SlashCommand { id: string; label: string; hint: string }
export const slashCommands: SlashCommand[] = [
  { id: "summarize", label: "/summarize", hint: "Condense text or a file into key points" },
  { id: "translate", label: "/translate", hint: "Translate into another language" },
  { id: "explain", label: "/explain", hint: "Walk through code or an idea step by step" },
  { id: "fix", label: "/fix", hint: "Find and fix a bug in the code" },
];

export type ContextKind = "code" | "sheet" | "pdf" | "notion" | "linear" | "figma";
export interface ContextItem { id: string; label: string; group: "Files" | "Docs"; meta: string; kind: ContextKind }
export const contextItems: ContextItem[] = [
  { id: "checkout", label: "checkout.tsx", group: "Files", meta: "src/app/checkout", kind: "code" },
  { id: "pricing", label: "pricing-q4.csv", group: "Files", meta: "data/finance", kind: "sheet" },
  { id: "guidelines", label: "brand-guidelines.pdf", group: "Files", meta: "Design, 4.8 MB", kind: "pdf" },
  { id: "launch", label: "Q4 launch plan", group: "Docs", meta: "Notion, edited Oct 18", kind: "notion" },
  { id: "retries", label: "Checkout retries", group: "Docs", meta: "Linear, ENG-2481", kind: "linear" },
  { id: "flow", label: "Checkout flow v3", group: "Docs", meta: "Figma, edited Oct 16", kind: "figma" },
];

export interface Suggestion { id: string; label: string; prompt: string; icon?: "summary" | "draft" | "bug" }
export const sampleSuggestions: Suggestion[] = [
  { id: "launch", label: "Summarize the Q4 launch plan", prompt: "/summarize @Q4 launch plan and list the open risks", icon: "summary" },
  { id: "reply", label: "Draft a reply to Priya", prompt: "Draft a short reply to Priya about the annual discount on the Team plan", icon: "draft" },
  { id: "bug", label: "Explain the checkout retry bug", prompt: "/explain why @checkout.tsx can charge a card twice on a slow network", icon: "bug" },
];

/** The sentence the simulated dictation types in. */
export const dictationSentence = "Move the launch review to Thursday, October 29, and ask Priya to bring the updated pricing numbers.";

/** Two sentence replies, picked by the command or the words in the message. */
export function sampleReply(text: string): string {
  const t = text.toLowerCase();
  if (t.startsWith("/summarize") || t.includes("launch plan")) {
    return "The Q4 launch moves the self-serve tier to November 12, with the new pricing landing a week earlier on November 5. The main open risk is the checkout migration, which still needs a load test before the code freeze on October 30.";
  }
  if (t.includes("launch post") || t.includes("pricing page")) {
    return "Here is a draft: “Our new pricing page is live. Every plan now shows exactly what you get, annual billing saves 20 percent, and you can switch plans any time without talking to sales.” Want a shorter version for X?";
  }
  if (t.startsWith("/translate")) {
    return "Hier ist die Übersetzung: Wir verschieben das Launch-Review auf Donnerstag, den 29. Oktober. Bitte bring die aktualisierten Preiszahlen mit.";
  }
  if (t.startsWith("/fix")) {
    return "The retry in submitPayment builds a new idempotency key on every attempt, so the processor treats each retry as a fresh charge. Create the key once per checkout and pass it to every retry, then cap retries at three with backoff.";
  }
  if (t.startsWith("/explain") || t.includes("checkout")) {
    return "When the first request times out, checkout.tsx retries the payment without the original idempotency key, so a slow network can produce a second charge. Reusing that key on every retry makes the processor return the first result instead of charging again.";
  }
  if (t.includes("priya") || t.includes("reply") || t.includes("draft")) {
    return "Here is a draft: “Thanks for the detailed notes, Priya. We will keep the annual discount on the Team plan at 20 percent and revisit seat minimums after the November 12 review.”";
  }
  if (t.includes("thursday") || t.includes("october 29")) {
    return "I moved the launch review to Thursday, October 29 at 10:00 and sent Priya a note asking for the updated pricing numbers. The invite now links the Q4 launch plan so everyone opens the same version.";
  }
  return "Here is where I would start: name the decision you need, then list the facts that support it and the questions still open. Add a file with the plus button or mention a doc with @, and I can work from the real details.";
}

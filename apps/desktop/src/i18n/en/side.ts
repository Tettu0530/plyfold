import type { side as source } from "../ja/side";

export const side: Record<keyof typeof source, string> = {
  open: "Side chat",
  title: "Side chat",
  forkedNow: "Forked just now",
  forkedAgo: "Forked {n} min ago",
  refresh: "Fork again from the main conversation as it is now (this chat is cleared)",
  close: "Close (this chat is cleared)",
  starting: "Copying the main conversation",
  hint: "A fork of the main conversation. Questions and answers here stay out of it. Edits and commands are declined",
  quote: "Add to the main input",
  placeholder: "Ask about the main session",
};

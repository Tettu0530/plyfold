// pane/Composer.tsx (input box, model / effort, context, queue)
import type { composer as source } from "../ja/composer";

export const composer: Record<keyof typeof source, string> = {
  inputTotal: "Input (total)",
  cachedPart: "Cached",
  outputTotal: "Output (total)",
  costTotal: "Cost (total)",
  contextDetails: "Context details",
  contextUsage: "Context usage",
  context: "Context",
  reportedModel: "Reported model",
  switchMode: "Switch mode (current: {mode}, ⇧⇥)",
  queueSendAfterTurn: "Queued until the turn ends",
  queueUnsent: "Unsent messages",
  sendFirst: "Send next",
  attachmentsCount: "{count, plural, one {# attachment} other {# attachments}}",
  removeFromQueue: "Remove from queue",
  message: "Message",
  stopEsc: "Stop (esc)",
  addToQueue: "Add to queue",
  send: "Send",
  addToQueueHint: "Add to queue (sends when the turn ends)",
};

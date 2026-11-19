import type { SavedPrompt } from "./types";

/** Fill `{repo}` and `{branch}` from the session the message is used in. Other braces stay as written */
export function fillPrompt(body: string, fields: { repo: string; branch: string }): string {
  return body.replaceAll("{repo}", fields.repo).replaceAll("{branch}", fields.branch);
}

/** A message limited to a repository can be inserted only into a session of that repository */
export function canInsert(prompt: Pick<SavedPrompt, "repo">, sessionRepo: string | null): boolean {
  return !prompt.repo || prompt.repo === sessionRepo;
}

export function matchesQuery(prompt: Pick<SavedPrompt, "name" | "body">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return prompt.name.toLowerCase().includes(q) || prompt.body.toLowerCase().includes(q);
}

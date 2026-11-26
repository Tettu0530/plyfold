// The verdict reviewer starts its answer with "Take: <run>" (採用 / 采用 in the other languages). Read which run that is.

const TAKE = /^\s*[#>*\-\s]*(?:採用|采用|take|adopt)\s*[:：]\s*(.+)$/im;

/** The run's name as the reviewer was shown it: the profile, or the agent for a default profile */
export const runLabel = (r: { profile: string; agent: string }) => (r.profile === r.agent ? r.agent : r.profile);

const plain = (s: string) =>
  s
    .replace(/[*_`"'「」『』()（）[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The id of the run the verdict names, or null when it names none (or more than one) of them */
export function verdictChoice(answer: string, runs: { id: string; profile: string; agent: string }[]): string | null {
  const line = TAKE.exec(answer)?.[1];
  if (!line) return null;
  const said = plain(line);
  // The longest name inside the line wins ("codex-xerosharc" over "codex")
  const hits = runs
    .map((r) => ({ id: r.id, label: plain(runLabel(r)) }))
    .filter((r) => r.label && said.includes(r.label))
    .sort((a, b) => b.label.length - a.label.length);
  if (hits.length === 0) return null;
  const best = hits[0];
  // Two runs named in the line (a comparison, not a choice): no choice
  return hits.filter((h) => !best.label.includes(h.label) || h.id === best.id).length > 1 ? null : best.id;
}

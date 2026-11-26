// The sessions started together from one prompt, side by side in numbers: how each did (state, time, tokens, cost,
// diff), and a way to take the one you want into the repository and put the rest in the trash
import { Check, Columns3, ExternalLink, GitBranch, GitMerge, Scale, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useT } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { money, seconds, tokens } from "@/lib/format";
import type { SessionRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { compareGroupOf, isListed, useStore, type SessionView } from "@/state/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentName, ProfileOption, ProviderLogo, Spinner, STATUS, StatusIcon } from "../icons";
import { startDrag } from "./dnd";
import { PaneMenu, paneHeadAnchor } from "./PaneMenu";

const BUSY = new Set(["starting", "working", "awaiting_permission", "stalled"]);

/** What a session's turns add up to (from the transcript in memory) */
export function totals(v: SessionView): { ms: number; input: number; output: number; turns: number } {
  let ms = 0;
  let input = 0;
  let output = 0;
  let turns = 0;
  for (const it of v.transcript.items) {
    if (it.kind !== "stats" || !it.stats) continue;
    turns += 1;
    ms += it.stats.elapsed_ms;
    const u = it.stats.usage;
    if (u) {
      input += u.input + u.cached_read + u.cached_write;
      output += u.output;
    }
  }
  return { ms, input, output, turns };
}

type DiffSum = { files: number; added: number; removed: number };

/** The worktree's changes, read again when the state changes and every few seconds while it works */
function useDiff(id: string, status: string): DiffSum | null {
  const [sum, setSum] = useState<DiffSum | null>(null);
  const version = useStore((s) => s.diffVersion);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    const load = () =>
      api.sessionDiff(id).then(
        (d) => alive && setSum({ files: d.files.length, added: d.files.reduce((a, f) => a + f.added, 0), removed: d.files.reduce((a, f) => a + f.removed, 0) }),
        () => alive && setSum(null),
      );
    void load();
    const timer = BUSY.has(status) ? setInterval(load, 5000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [id, status, version]);
  return sum;
}

export function ComparePane({ index, id }: { index: number; id: string }) {
  const t = useT();
  const group = compareGroupOf(id);
  const sessions = useStore((s) => s.sessions);
  const focused = useStore((s) => s.focusedPane === index);
  const { focusPane, closePane } = useStore.getState();
  const members = useMemo(
    () =>
      Object.values(sessions)
        .filter((v) => isListed(v) && v.record.run_group === group)
        .sort((a, b) => a.record.created_at - b.record.created_at),
    [sessions, group],
  );
  // After one is merged: which, and where it went
  const [merged, setMerged] = useState<{ id: string; target: string } | null>(null);
  const title = members[0]?.record.title ?? t("compare.title");

  return (
    <section
      aria-label={t("compare.paneLabel", { title })}
      onMouseDown={() => focusPane(index)}
      className={cn("@container flex min-w-0 flex-col", focused && "bg-white/[0.01]")}
    >
      <PaneMenu slot={index}>
        <div
          ref={paneHeadAnchor(index)}
          onPointerDown={(e) => startDrag(e, () => ({ kind: "pane", slot: index, title: t("compare.paneLabel", { title }) }))}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b pr-1.5 pl-3"
        >
          <Columns3 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{title}</span>
          <span className="hidden text-xs text-muted-foreground @[20rem]:inline">{t("compare.title")}</span>
          <span className="grow" />
          <button
            type="button"
            aria-label={t("pane.closePane")}
            onClick={() => closePane(index)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </PaneMenu>

      <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto p-3">
        {members.length === 0 && <p className="p-1 text-xs text-muted-foreground">{t("compare.empty")}</p>}
        {members.length >= 2 && <VerdictBar group={group} members={members} />}
        {members.map((v) => (
          <Row key={v.record.id} v={v} merged={merged} onMerged={(target) => setMerged({ id: v.record.id, target })} />
        ))}
        {merged && members.length > 1 && <TrashOthers keep={merged.id} others={members.filter((m) => m.record.id !== merged.id).map((m) => m.record)} />}
      </div>
    </section>
  );
}

/** Ask a reviewer which run to take: it reads every run's diff and numbers, and answers in a session of its own */
function VerdictBar({ group, members }: { group: string; members: SessionView[] }) {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const names = profiles.map((p) => p.name);
  // A reviewer apart from the runs judges more fairly: start from a profile none of them used
  const [choice, setChoice] = useState<string | null>(null);
  const used = new Set(members.map((m) => m.record.profile));
  const profile = choice && names.includes(choice) ? choice : (names.find((n) => !used.has(n)) ?? names[0] ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = members.some((m) => BUSY.has(m.record.status));

  const ask = async () => {
    setPending(true);
    setError(null);
    try {
      const first = members[0].transcript.items.find((it) => it.kind === "user");
      const facts: [string, string][] = members.map((m) => {
        const sum = totals(m);
        const cost = m.info?.cost ? money(m.info.cost.amount, m.info.cost.currency) : "—";
        return [m.record.id, `time ${sum.ms > 0 ? seconds(sum.ms) : "—"} · tokens ↑${tokens(sum.input)} ↓${tokens(sum.output)} · cost ${cost}`];
      });
      const id = await api.compareVerdict(group, profile, first?.kind === "user" ? first.text : "", facts);
      await useStore.getState().openInPane(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Scale className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs text-muted-foreground">{t("compare.verdictBy")}</span>
        <Select value={profile} onValueChange={setChoice} disabled={pending}>
          <SelectTrigger size="sm" aria-label={t("compare.verdictBy")} className="min-w-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {profiles.map((p) => (
              <SelectItem key={p.name} value={p.name}>
                <ProfileOption profile={p} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="grow" />
        <Action
          icon={pending ? <Spinner className="size-3.5" /> : <Scale className="size-3.5" aria-hidden />}
          onClick={() => void ask()}
          disabled={busy || pending || !profile}
          title={busy ? t("compare.verdictBusy") : undefined}
        >
          {t("compare.verdict")}
        </Action>
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t("compare.verdictHint")}</p>
      {error && <p className="m-0 text-xs whitespace-pre-wrap text-error">{error}</p>}
    </div>
  );
}

function Row({ v, merged, onMerged }: { v: SessionView; merged: { id: string; target: string } | null; onMerged: (target: string) => void }) {
  const t = useT();
  const r = v.record;
  const sum = totals(v);
  const diff = useDiff(r.id, r.status);
  const busy = BUSY.has(r.status);
  const st = STATUS[r.status];
  const [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { openInPane, openDiff, bumpDiff } = useStore.getState();
  const isMerged = merged?.id === r.id;
  // A default profile is named by its agent (two "default"s side by side would look the same)
  const profile = r.profile === r.agent ? agentName(r.agent) : r.profile;

  const merge = async () => {
    setWorking(true);
    setError(null);
    try {
      const wt = await api.worktreeStatus(r.id);
      if (wt.dirty) await api.commitSession(r.id, r.title);
      const done = await api.mergeSession(r.id);
      bumpDiff();
      onMerged(done.target);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
      setConfirm(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2 rounded-[10px] border p-3", isMerged && "border-working/40")}>
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo agent={r.agent} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{profile}</span>
        <span className={cn("flex shrink-0 items-center gap-1 text-xs", r.status === "idle" || r.status === "closed" ? "text-muted-foreground" : st.color)}>
          <StatusIcon status={r.status} className="size-3" />
          {st.label}
        </span>
        <span className="grow" />
        {isMerged && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-working">
            <Check className="size-3.5" aria-hidden />
            {t("compare.mergedInto", { target: merged.target })}
          </span>
        )}
      </div>
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-4 gap-y-1 text-xs">
        <Fact label={t("compare.time")}>{sum.ms > 0 ? seconds(sum.ms) : "—"}</Fact>
        <Fact label={t("compare.tokens")}>{sum.turns > 0 ? `↑${tokens(sum.input)} ↓${tokens(sum.output)}` : "—"}</Fact>
        <Fact label={t("compare.cost")}>{v.info?.cost ? money(v.info.cost.amount, v.info.cost.currency) : "—"}</Fact>
        <Fact label={t("compare.changes")}>
          {diff ? (
            <>
              <span className="text-working">+{diff.added}</span> <span className="text-error">−{diff.removed}</span>{" "}
              <span className="text-muted-foreground">{t("compare.files", { count: diff.files })}</span>
            </>
          ) : (
            "—"
          )}
        </Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-1">
        <Action icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => void openInPane(r.id, undefined, `session:${r.id}`)}>
          {t("compare.open")}
        </Action>
        <Action icon={<GitBranch className="size-3.5" aria-hidden />} onClick={() => openDiff(r.id)}>
          {t("compare.diff")}
        </Action>
        <span className="grow" />
        {!merged &&
          (confirm ? (
            <>
              <span className="text-xs text-muted-foreground">{t("compare.mergeConfirm")}</span>
              <Action icon={<GitMerge className="size-3.5" aria-hidden />} onClick={() => void merge()} disabled={working} primary>
                {t("compare.mergeYes")}
              </Action>
              <Action onClick={() => setConfirm(false)}>{t("sessionMenu.cancel")}</Action>
            </>
          ) : (
            <Action
              icon={<GitMerge className="size-3.5" aria-hidden />}
              onClick={() => setConfirm(true)}
              disabled={busy || !diff || diff.files === 0}
              title={busy ? t("compare.mergeBusy") : !diff || diff.files === 0 ? t("compare.mergeNothing") : undefined}
            >
              {t("compare.merge")}
            </Action>
          ))}
      </div>
      {error && <p className="text-xs whitespace-pre-wrap text-error">{error}</p>}
    </div>
  );
}

/** After one is taken in: the others go to the trash together (restorable from there) */
function TrashOthers({ keep, others }: { keep: string; others: SessionRecord[] }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  void keep;
  if (done) return null;
  return (
    <div className="flex items-center gap-2 px-1 text-xs">
      <span className="grow text-muted-foreground">{t("compare.trashOthersHint", { count: others.length })}</span>
      <Action
        icon={<Trash2 className="size-3.5" aria-hidden />}
        onClick={() =>
          void Promise.all(others.map((o) => useStore.getState().trashSession(o.id))).then(
            () => setDone(true),
            (e) => setError(String(e)),
          )
        }
      >
        {t("compare.trashOthers")}
      </Action>
      {error && <span className="text-error">{error}</span>}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 truncate font-mono tabular">{children}</dd>
    </div>
  );
}

function Action({
  icon,
  onClick,
  disabled,
  primary,
  title,
  children,
}: {
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs disabled:pointer-events-none disabled:opacity-40",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-input hover:bg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

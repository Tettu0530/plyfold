// unified diff（git diff の出力）を、ファイルごとの行に分ける

export type LineKind = "ctx" | "add" | "del" | "hunk" | "note";

export interface PatchLine {
  kind: LineKind;
  /** 元の行番号（追加・見出しは null） */
  old: number | null;
  /** 新しい行番号（削除・見出しは null） */
  new: number | null;
  text: string;
}

export interface FilePatch {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  lines: PatchLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // 仮の名前（--- / +++ が来たら置き換える）
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m ? m[2] : line.slice(11), status: "modified", binary: false, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename to ")) {
        cur.status = "renamed";
        cur.path = line.slice(10);
      } else if (line.startsWith("Binary files ")) cur.binary = true;
      else if (line.startsWith("+++ ")) {
        const p = stripPrefix(line.slice(4));
        if (p) cur.path = p;
      } else if (line.startsWith("--- ")) {
        const p = stripPrefix(line.slice(4));
        if (p && cur.status === "deleted") cur.path = p;
      }
    }
    const h = HUNK.exec(line);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur.lines.push({ kind: "hunk", old: null, new: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    const c = line[0];
    const text = line.slice(1);
    if (c === "+") cur.lines.push({ kind: "add", old: null, new: newNo++, text });
    else if (c === "-") cur.lines.push({ kind: "del", old: oldNo++, new: null, text });
    else if (c === " ") cur.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text });
    else if (c === "\\") cur.lines.push({ kind: "note", old: null, new: null, text: line });
  }
  return files;
}

export interface SplitRow {
  kind: "hunk" | "pair";
  left: PatchLine | null;
  right: PatchLine | null;
}

/** 左右の表示: 続けて消した行と足した行を、横に並べる */
export function toSplit(lines: PatchLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "hunk") rows.push({ kind: "hunk", left: l, right: null });
      else if (l.kind === "ctx") rows.push({ kind: "pair", left: l, right: l });
    }
  }
  flush();
  return rows;
}

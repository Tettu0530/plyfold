export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/0$/, "")}M`;
}

export function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function age(ts: number, now = Date.now()): string {
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return "今";
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間`;
  return h < 48 ? "昨日" : `${Math.floor(h / 24)}日`;
}

export function money(amount: number, currency: string): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

export function repoName(path: string | null): string {
  if (!path) return "（リポジトリなし）";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

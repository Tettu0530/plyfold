import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { useT } from "@/i18n";

export function SessionTerminal({ session }: { session: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = new FitAddon();
    const term = new Terminal({ fontSize: 13, scrollback: 2000 });
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    term.focus();

    let disposed = false;
    let finished = false;
    let input = Promise.resolve();
    const fail = (cause: unknown) => {
      if (!disposed && !finished) setError(String(cause));
    };
    const output = new Channel<number[] | null>();
    output.onmessage = (bytes) => {
      if (disposed) return;
      if (bytes !== null) term.write(Uint8Array.from(bytes));
      else {
        finished = true;
        setExited(true);
      }
    };
    const start = invoke<number>("start_terminal", { session, rows: term.rows, cols: term.cols, output });
    void start.catch(fail);
    const encoder = new TextEncoder();
    const send = (data: Uint8Array) => {
      input = input
        .then(async () => {
          const terminal = await start;
          if (!disposed && !finished) await invoke("write_terminal", { terminal, data: Array.from(data) });
        })
        .catch(fail);
    };
    const keys = term.onData((data) => send(encoder.encode(data)));
    const binary = term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0))));
    const resize = term.onResize(({ rows, cols }) => {
      void start
        .then((terminal) => {
          if (!disposed && !finished) return invoke("resize_terminal", { terminal, rows, cols });
        })
        .catch(fail);
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (element.clientWidth && element.clientHeight) fit.fit();
      });
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      keys.dispose();
      binary.dispose();
      resize.dispose();
      term.dispose();
      void start.then((terminal) => invoke("stop_terminal", { terminal })).catch(() => {});
    };
  }, [session]);

  return (
    <div className="relative h-full min-w-0 overflow-hidden bg-black p-2" onKeyDown={(event) => event.stopPropagation()}>
      <div ref={host} className="h-full min-w-0" />
      {(error || exited) && (
        <p role="status" className="absolute right-2 bottom-2 left-2 rounded bg-background px-2 py-1 text-xs text-muted-foreground">
          {error ?? t("pane.terminalExited")}
        </p>
      )}
    </div>
  );
}

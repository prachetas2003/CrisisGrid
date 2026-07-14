import { useEffect } from "react";
import { useStore } from "./store/store";
import { TopBar } from "./components/TopBar";
import { CommandCenter } from "./screens/CommandCenter";
import { AgentRoom } from "./screens/AgentRoom";
import { Decisions } from "./screens/Decisions";
import { JudgeDrawer } from "./components/JudgeDrawer";
import { Icon } from "./components/Icon";

export default function App() {
  const { booted, bootError, boot, screen, judgeOpen } = useStore();

  useEffect(() => {
    void boot();
  }, [boot]);

  if (bootError) return <BootError message={bootError} retry={() => void boot()} />;
  if (!booted) return <BootSplash />;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="min-h-0 flex-1">
        {screen === "command" && <CommandCenter />}
        {screen === "agents" && <AgentRoom />}
        {screen === "decisions" && <Decisions />}
      </main>
      {judgeOpen && <JudgeDrawer />}
    </div>
  );
}

function BootSplash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="flex items-center gap-3">
        <span className="pulse-dot inline-block h-3 w-3 rounded-full bg-accent" />
        <span className="text-lg font-semibold tracking-wide">CrisisGrid</span>
      </div>
      <p className="text-sm text-mute">Connecting to the command center…</p>
    </div>
  );
}

function BootError({ message, retry }: { message: string; retry: () => void }) {
  const localDev = typeof window !== "undefined" && /localhost|127\.0\.0\.1/.test(window.location.hostname);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-panel p-8">
        <div className="mb-3 flex items-center gap-2 text-alert">
          <Icon name="alert" size={20} />
          <h1 className="text-base font-semibold">Service temporarily unavailable</h1>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-mute">
          CrisisGrid couldn't load the live command picture from the API. This is usually a short outage or a
          deploy that is still warming up — wait a moment and try again.
        </p>
        {localDev && (
          <p className="mb-4 text-sm leading-relaxed text-mute">
            Local development: start the stack from the repo root with{" "}
            <code className="rounded bg-ink px-1.5 py-0.5 font-mono text-xs text-accent">pnpm dev</code>.
          </p>
        )}
        <p className="mb-5 break-all font-mono text-xs text-dim">{message}</p>
        <button
          onClick={retry}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-110"
        >
          Retry connection
        </button>
      </div>
    </div>
  );
}

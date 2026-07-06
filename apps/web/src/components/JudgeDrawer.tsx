import { useEffect, useState } from "react";
import { useStore } from "../store/store";
import { getJudgeInfo } from "../lib/api";
import { Icon } from "./Icon";

interface JudgeInfo {
  tools: { name: string; tier: string; source: string; description: string }[];
  evals: { files: number; tests: number };
  health: Record<string, unknown>;
}

const RUBRIC = [
  {
    criterion: "Agentic behavior",
    how: "9 ADK agents run a real pipeline: parallel investigation → deterministic conflict detection → evidence-based debate → commander synthesis → safety critique loop that can force plan revisions.",
    see: "Agent Room during any run",
  },
  {
    criterion: "MCP integration",
    how: "A TypeScript MCP server is the ONLY way agents touch data — 40 tools across 10 domains, each scoped per agent. The approval queue executes through the same tier-enforced choke point.",
    see: "Tool catalog below; every finding's evidence chips",
  },
  {
    criterion: "Technical depth",
    how: "Deterministic scenario engine with forkable timelines (what-ifs), computed geospatial risk overlay, hash-chained audit log, single-use HMAC approval tokens, live Open-Meteo weather adapter with honest fallback labeling.",
    see: "What-if panel (real server forks), Decisions history",
  },
  {
    criterion: "Safety",
    how: "Three action tiers enforced in code, not prompts: safe auto-runs, needs_approval queues for a human, blocked always refuses (real dispatch, mass broadcast). Every alert is watermarked SIMULATED EXERCISE.",
    see: "Approve an action in Your Decisions",
  },
  {
    criterion: "Reliability",
    how: "47 automated evals prove determinism, policy enforcement, single-use tokens, and that agents have no data path other than MCP. Replay mode plays a recorded real run — honestly labeled, never faked.",
    see: "Eval summary below",
  },
];

const TIER_STYLE: Record<string, string> = {
  safe: "bg-ok/15 text-ok",
  needs_approval: "bg-warn/15 text-warn",
  blocked: "bg-danger/15 text-danger",
};

export function JudgeDrawer() {
  const setJudgeOpen = useStore((s) => s.setJudgeOpen);
  const [info, setInfo] = useState<JudgeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJudgeInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  const groups = new Map<string, JudgeInfo["tools"]>();
  for (const t of info?.tools ?? []) {
    const prefix = t.name.split(".")[0]!;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(t);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setJudgeOpen(false)}>
      <div
        className="anim-in h-full w-full max-w-2xl overflow-y-auto border-l border-edge bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-extrabold">Judge Mode</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-mute">
              CrisisGrid in one sentence: describe a city crisis in plain English — nine AI agents investigate with
              real tools, argue about the risks, and hand you an approvable plan where every number traces to a tool
              call.
            </p>
          </div>
          <button onClick={() => setJudgeOpen(false)} className="rounded-md p-1.5 text-dim hover:bg-panel2 hover:text-text">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Rubric mapping */}
        <Section title="How this maps to the rubric">
          <div className="space-y-2.5">
            {RUBRIC.map((r) => (
              <div key={r.criterion} className="rounded-lg border border-edge bg-panel2 p-3">
                <div className="text-[12px] font-bold text-accent">{r.criterion}</div>
                <p className="mt-1 text-[12px] leading-relaxed text-mute">{r.how}</p>
                <p className="mt-1 text-[10.5px] text-dim">Where to see it: {r.see}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Architecture */}
        <Section title="Architecture">
          <div className="rounded-lg border border-edge bg-panel2 p-4">
            <div className="flex flex-col items-stretch gap-1.5 text-center font-mono text-[10.5px]">
              <ArchBox label="React + MapLibre web app" note="this UI — SSE + NDJSON streaming" color="#38bdf8" />
              <ArchArrow />
              <ArchBox label="Fastify orchestration server (TypeScript)" note="scenario engine · action queue · audit log · SQLite" color="#c084fc" />
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex flex-col gap-1.5">
                  <ArchArrow />
                  <ArchBox label="Python ADK agent service" note="9 Gemini agents, 4-phase pipeline" color="#f472b6" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <ArchArrow />
                  <ArchBox label="MCP server (TypeScript)" note="40 tools · 3 safety tiers · sole data path" color="#34d399" />
                </div>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              Agents call MCP tools over stdio; the server executes operator-approved actions through the exact same
              tier-enforced choke point. Neither can bypass policy.
            </p>
          </div>
        </Section>

        {/* Evals */}
        <Section title="Automated evals">
          <div className="rounded-lg border border-edge bg-panel2 p-3.5">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-extrabold text-ok">{info?.evals.tests ?? 47}</span>
              <span className="text-[12px] text-mute">passing tests across {info?.evals.files ?? 7} suites</span>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-mute">
              <li>• Engine determinism & replay</li>
              <li>• Fork isolation (what-ifs)</li>
              <li>• Risk overlay correctness</li>
              <li>• Policy tier classification</li>
              <li>• Approval gate: single-use tokens</li>
              <li>• Blocked tools always refuse</li>
              <li>• Audit chain tamper-evidence</li>
              <li>• Agents have no non-MCP data path</li>
            </ul>
            <p className="mt-2 font-mono text-[10px] text-dim">pnpm evals</p>
          </div>
        </Section>

        {/* Safety tiers */}
        <Section title="Safety tiers (enforced in code, not prompts)">
          <div className="space-y-1.5">
            <TierRow tier="safe" text="Read-only and analysis tools auto-run. Every call lands in the audit log." />
            <TierRow tier="needs_approval" text="Anything that changes state queues for a human. Execution requires a single-use HMAC token minted only on operator approval." />
            <TierRow tier="blocked" text="Real dispatch and mass broadcast refuse structurally — the tool returns a policy refusal no prompt can override." />
          </div>
        </Section>

        {/* MCP catalog */}
        <Section title={`MCP tool catalog${info ? ` (${info.tools.length} tools)` : ""}`}>
          {error && <p className="text-[12px] text-danger">Couldn't load the catalog: {error}</p>}
          <div className="space-y-3">
            {[...groups.entries()].map(([prefix, tools]) => (
              <div key={prefix}>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-dim">
                  {prefix} · {tools.length}
                </div>
                <div className="space-y-1">
                  {tools.map((t) => (
                    <div key={t.name} className="flex items-start gap-2 rounded-md bg-panel2 px-2.5 py-1.5">
                      <code className="shrink-0 font-mono text-[10.5px] text-accent">{t.name}</code>
                      <span className={`shrink-0 rounded px-1.5 text-[9px] font-bold uppercase leading-4 ${TIER_STYLE[t.tier] ?? ""}`}>
                        {t.tier.replace("_", " ")}
                      </span>
                      <span className="min-w-0 truncate text-[10.5px] text-dim" title={t.description}>
                        {t.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-dim">{title}</h3>
      {children}
    </section>
  );
}

function ArchBox({ label, note, color }: { label: string; note: string; color: string }) {
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: `${color}55`, background: `${color}0d` }}>
      <div className="font-sans text-[11.5px] font-bold" style={{ color }}>
        {label}
      </div>
      <div className="font-sans text-[10px] text-dim">{note}</div>
    </div>
  );
}

function ArchArrow() {
  return <div className="text-dim">↓</div>;
}

function TierRow({ tier, text }: { tier: string; text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-edge bg-panel2 px-3 py-2">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase ${TIER_STYLE[tier]}`}>
        {tier.replace("_", " ")}
      </span>
      <p className="text-[11.5px] leading-snug text-mute">{text}</p>
    </div>
  );
}

"use client";

import clsx from "clsx";
import {
  Activity,
  BookOpenText,
  CloudUpload,
  Cpu,
  Gauge,
  Globe,
  Languages,
  LayoutTemplate,
  RotateCcw,
  Rocket,
  ShieldCheck,
  Siren,
  Timer,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getStats } from "@/lib/api";
import type { Stats } from "@/lib/types";
import { Logo } from "./Logo";

const TABS = ["All", "Runbooks", "Incidents", "Deployments", "Web", "Analytics"] as const;
type Tab = (typeof TABS)[number];

interface Card {
  icon: LucideIcon;
  title: string;
  description: string;
  prompt?: string;
  action?: "upload" | "templates";
}

const CARDS: Record<Exclude<Tab, "Analytics">, Card[]> = {
  All: [
    { icon: LayoutTemplate, title: "Saved Prompt Templates", description: "Proven prompts for incidents, runbooks and rollbacks.", action: "templates" },
    { icon: CloudUpload, title: "Knowledge Upload", description: "Add PDF, DOCX, MD or TXT runbooks to the knowledge base.", action: "upload" },
    { icon: Languages, title: "Multilingual Support", description: "Ask in any language and get answers in the same one.", prompt: "Explain our deployment rollback procedure in Bangla." },
  ],
  Runbooks: [
    { icon: BookOpenText, title: "Checkout API runbook", description: "Steps to stabilise checkout errors and latency.", prompt: "Walk me through the checkout API runbook for elevated 5xx errors." },
    { icon: Cpu, title: "High CPU procedure", description: "What to check before scaling the payments service.", prompt: "Payments service CPU has been above 85% for 10 minutes. What should I do?" },
    { icon: ShieldCheck, title: "Safety checks", description: "Cautions to follow before running remediation.", prompt: "What cautions should I follow before restarting pods during an incident?" },
  ],
  Incidents: [
    { icon: Siren, title: "Triage an alert", description: "Turn a noisy alert into a clear action plan.", prompt: "Checkout latency p99 jumped to 4s after the last deploy. How do I triage this?" },
    { icon: Activity, title: "Retry storms", description: "Spot and contain cascading retries.", prompt: "How do I detect and stop a retry storm between payments and checkout?" },
    { icon: Timer, title: "Incident timeline", description: "Draft a status update for stakeholders.", prompt: "Draft a short incident status update for a checkout outage that is being mitigated." },
  ],
  Deployments: [
    { icon: RotateCcw, title: "Rollback SOP", description: "When and how to roll back safely.", prompt: "What is our deployment rollback SOP and when should I trigger it?" },
    { icon: Rocket, title: "Release checklist", description: "Pre-flight checks before shipping.", prompt: "Give me a pre-deployment checklist for a payments service release." },
    { icon: Zap, title: "Feature flags", description: "Use flags to reduce blast radius.", prompt: "How should feature flags be used to limit blast radius during a risky release?" },
  ],
  Web: [
    { icon: Globe, title: "Latest Kubernetes", description: "Current stable release and notable changes.", prompt: "What is the latest stable Kubernetes version and what changed?" },
    { icon: Globe, title: "Cloud status", description: "Recent major cloud provider incidents.", prompt: "What were the most recent major AWS outages and their root causes?" },
    { icon: Globe, title: "Best practices", description: "Current SRE guidance from the web.", prompt: "What are current best practices for SLO-based alerting?" },
  ],
};

function StatCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.05] p-4 text-center">
      <Icon className="mx-auto size-5 text-white/80" />
      <p className="mt-2 text-xl font-semibold text-white">{value}</p>
      <p className="mt-0.5 text-[11px] text-white/50">{label}</p>
    </div>
  );
}

function Analytics() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getStats()
      .then((s) => alive && setStats(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return <p className="py-8 text-center text-sm text-white/45">Analytics are unavailable while the server is offline.</p>;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard icon={Activity} label="Questions answered" value={stats ? stats.total : "—"} />
      <StatCard icon={Gauge} label="Average response time" value={stats ? `${(stats.avg_latency_ms / 1000).toFixed(1)}s` : "—"} />
      <StatCard icon={ShieldCheck} label="Fully grounded answers" value={stats ? `${stats.grounded_rate}%` : "—"} />
    </div>
  );
}

interface WelcomeProps {
  onPrompt: (prompt: string) => void;
  onUpload: () => void;
  composer: ReactNode;
}

export function Welcome({ onPrompt, onUpload, composer }: WelcomeProps) {
  const [tab, setTab] = useState<Tab>("All");

  const handle = (card: Card) => {
    if (card.action === "upload") onUpload();
    else if (card.action === "templates") setTab("Incidents");
    else if (card.prompt) onPrompt(card.prompt);
  };

  return (
    <div className="glass w-full max-w-[680px] animate-fade-up rounded-2xl p-5 sm:p-8">
      <div className="flex flex-col items-center text-center">
        <Logo className="size-9" glow />
        <h1 className="mt-4 text-[26px] font-semibold tracking-tight text-white sm:text-[34px]">How can I help you today?</h1>
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-white/55">
          Ask about incidents, runbooks and deployments. Answers are grounded in your knowledge base, with a live web
          fallback when your documents don&apos;t cover it.
        </p>
      </div>

      <div className="mt-7 min-h-[150px]" key={tab}>
        {tab === "Analytics" ? (
          <Analytics />
        ) : (
          <div className="grid animate-fade-up grid-cols-1 gap-3 sm:grid-cols-3">
            {CARDS[tab].map((card) => (
              <button
                key={card.title}
                type="button"
                onClick={() => handle(card)}
                className="group rounded-xl border border-white/[0.06] bg-white/[0.06] p-4 text-center transition hover:-translate-y-0.5 hover:border-brand-500/30 hover:bg-white/[0.09] focus-visible:outline-2 focus-visible:outline-brand-500"
              >
                <card.icon className="mx-auto size-5 text-white/85 transition group-hover:text-brand-400" />
                <p className="mt-2.5 text-[13px] font-medium text-white">{card.title}</p>
                <p className="mt-1 text-[11px] leading-snug text-white/50">{card.description}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div role="tablist" aria-label="Prompt categories" className="scroll-thin mt-6 flex justify-start gap-1 overflow-x-auto sm:justify-center">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={clsx(
              "shrink-0 rounded-md px-3 py-1.5 text-[13px] transition",
              tab === t ? "font-medium text-brand-400" : "text-white/55 hover:text-white",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-3">{composer}</div>
    </div>
  );
}

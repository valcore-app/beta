import Link from "next/link";
import { Button } from "../components/ui/button";

const socialLinks = [
  { key: "x", href: "https://x.com/valcore_app", aria: "Valcore on X" },
  { key: "discord", href: "#", aria: "Valcore on Discord" },
];

const gameLoop = [
  {
    title: "Design Your Strategy",
    text: "Draft your strategy allocation, balance risk by role, and shape your structure before lock.",
  },
  {
    title: "Lock In",
    text: "When epoch lock hits, start prices are fixed. Your epoch score begins from that baseline.",
  },
  {
    title: "Run The Live Epoch",
    text: "Track live movement, spend tactical moves wisely, and adapt your allocation under pressure.",
  },
  {
    title: "Settle And Distribute",
    text: "After settlement, results are finalized on-chain and yield distribution is claimable in one clear flow.",
  },
];

const featureRows = [
  {
    title: "Competitive By Design",
    text: "This is a strategy competition protocol first. Win rate balance and score behavior are continuously tuned in public test cycles.",
  },
  {
    title: "Transparent Rules",
    text: "Scoring logic, epoch flow, and distribution behavior are visible and testable. No black-box logic.",
  },
  {
    title: "Built For Repeat Execution",
    text: "Epoch reset, tactical constraints, and role structure keep each cycle fresh and skill-driven.",
  },
];

function SocialIcon({ name }: { name: string }) {
  if (name === "x") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
        <path
          d="M5 4L19 20M19 4L5 20"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (name === "discord") {
    return (
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" aria-hidden="true">
        <path
          d="M7.4 8.1c2.8-1.4 6.4-1.4 9.2 0l.9 7.1c-2.1 1.7-4.1 2.6-5.5 2.6s-3.4-.9-5.5-2.6l.9-7.1Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <circle cx="10" cy="12.2" r="1.1" fill="currentColor" />
        <circle cx="14" cy="12.2" r="1.1" fill="currentColor" />
      </svg>
    );
  }
  if (name === "telegram") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
        <path
          d="M20 4L3.5 10.3c-.8.3-.8 1.4 0 1.7l4.1 1.2 1.5 4.6c.2.7 1.1.9 1.6.3l2.3-2.6 4.3 3c.7.5 1.6.1 1.8-.8L21 5.3c.1-.8-.6-1.5-1.4-1.3Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M9.5 20c-3.5 1.1-3.5-1.8-5-2.3M14.5 22v-3.1a2.7 2.7 0 0 0-.7-2.1c2.3-.3 4.7-1.1 4.7-5a3.9 3.9 0 0 0-1-2.7 3.6 3.6 0 0 0-.1-2.7s-.8-.3-2.8 1A9.8 9.8 0 0 0 12 7a9.8 9.8 0 0 0-2.6.4c-2-1.3-2.8-1-2.8-1a3.6 3.6 0 0 0-.1 2.7 3.9 3.9 0 0 0-1 2.7c0 3.9 2.4 4.7 4.7 5a2.7 2.7 0 0 0-.7 2.1V22"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[color:var(--arena-bg)] text-[color:var(--arena-ink)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(20,184,166,0.2),transparent_42%),radial-gradient(circle_at_88%_8%,rgba(20,184,166,0.12),transparent_35%),linear-gradient(180deg,rgba(10,10,10,0.92),rgba(10,10,10,1))]" />

      <div className="relative mx-auto flex w-full max-w-[1280px] flex-col px-6 pb-20 pt-8 md:px-10">
        <header className="arena-panel-soft mb-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl px-4 py-3">
          <Link href="/" className="inline-flex items-center gap-3" aria-label="Valcore Home">
            <img src="/brand/logo.png" alt="Valcore" className="h-10 w-auto md:h-11" />
            <span className="arena-label hidden md:inline">Strategy Competition Protocol</span>
          </Link>

          <nav className="hidden items-center gap-5 text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)] md:flex">
            <a href="#how-it-works" className="transition hover:text-[color:var(--arena-ink)]">
              How It Works
            </a>
            <a href="#execution" className="transition hover:text-[color:var(--arena-ink)]">
              Protocol
            </a>
            <a href="#faq" className="transition hover:text-[color:var(--arena-ink)]">
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <Link href="/strategy" className="ml-1">
              <Button variant="glow" size="sm">
                Launch App
              </Button>
            </Link>
          </div>
        </header>

        <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <span className="arena-chip">Web3 Strategy Competition Protocol</span>
            <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
              Allocate with discipline. Reallocate with intent. Climb each epoch.
            </h1>
            <p className="max-w-[640px] text-base text-[color:var(--arena-muted)] md:text-lg">
              Valcore turns market movement into a structured competition engine. Build your strategy, lock your allocation, and operate
              through live conditions to finish each epoch higher on the board.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/strategy">
                <Button variant="glow" size="lg">
                  Enter This Epoch
                </Button>
              </Link>
              <a href="#how-it-works">
                <Button variant="outline" size="lg">
                  How It Works
                </Button>
              </a>
            </div>
            <p className="text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">
              Downside capped - Upside amplified
            </p>
          </div>

          <div className="arena-panel rounded-3xl p-6">
            <div className="mb-4 flex items-center justify-between">
              <span className="arena-label">Current Epoch Loop</span>
              <span className="rounded-full border border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--arena-accent)]">
                Live
              </span>
            </div>
            <div className="space-y-3">
              {gameLoop.map((item, index) => (
                <div
                  key={item.title}
                  className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-4 py-3"
                >
                  <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] text-[10px]">
                      {index + 1}
                    </span>
                    {item.title}
                  </div>
                  <p className="text-xs text-[color:var(--arena-muted)]">{item.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mt-14 grid gap-4 md:grid-cols-3">
          {featureRows.map((item) => (
            <article key={item.title} className="arena-panel rounded-3xl p-6">
              <h2 className="mb-2 text-xl font-semibold">{item.title}</h2>
              <p className="text-sm text-[color:var(--arena-muted)]">{item.text}</p>
            </article>
          ))}
        </section>

        <section id="execution" className="arena-panel mt-14 rounded-3xl p-7 md:p-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="arena-chip">Protocol Core</span>
              <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight">Execute with precision, not luck.</h2>
            </div>
            <Link href="/strategy">
              <Button variant="outline">Open Strategy Board</Button>
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-5">
              <h3 className="mb-2 text-lg font-semibold">Scoring Pressure</h3>
              <p className="text-sm text-[color:var(--arena-muted)]">
                Role multipliers and tactical swap limits force trade-offs. Every move has cost, timing, and impact.
              </p>
            </div>
            <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-5">
              <h3 className="mb-2 text-lg font-semibold">Epoch Competition</h3>
              <p className="text-sm text-[color:var(--arena-muted)]">
                Epochs are discrete competitions. You adapt during the epoch, settle at finalize, then return stronger next cycle.
              </p>
            </div>
          </div>
        </section>

        <section id="faq" className="arena-panel mt-14 rounded-3xl p-7 md:p-8">
          <h2 className="font-display text-3xl font-semibold tracking-tight">Quick FAQ</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <article className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-5">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em]">Is this financial advice?</h3>
              <p className="text-sm text-[color:var(--arena-muted)]">
                No. Valcore is a strategy competition protocol. Strategists are responsible for their own decisions.
              </p>
            </article>
            <article className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-5">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em]">Do I need to connect first?</h3>
              <p className="text-sm text-[color:var(--arena-muted)]">
                You can explore first. Connect when you are ready to lock a strategy allocation and join epoch competition.
              </p>
            </article>
            <article className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-5">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.1em]">Where do I start?</h3>
              <p className="text-sm text-[color:var(--arena-muted)]">
                Launch the app, open the strategy board, and follow the in-context guide to complete your first epoch.
              </p>
            </article>
          </div>
        </section>

        <footer className="mt-10 border-t border-[color:var(--arena-stroke)] pt-6 text-xs text-[color:var(--arena-muted)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Valcore is a competitive strategy protocol. Participation includes risk.</p>
            <div className="flex items-center gap-2">
              {socialLinks.map((item) => (
                <a
                  key={item.key}
                  href={item.href}
                  aria-label={item.aria}
                  target={item.key === "x" ? "_blank" : undefined}
                  rel={item.key === "x" ? "noreferrer" : undefined}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] text-[color:var(--arena-muted)] transition hover:border-[color:var(--arena-accent)] hover:text-[color:var(--arena-ink)]"
                >
                  <SocialIcon name={item.key} />
                </a>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}


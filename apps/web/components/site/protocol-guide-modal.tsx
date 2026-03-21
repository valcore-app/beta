"use client";

import { useEffect, useMemo, useState } from "react";
import {
  normalizeProtocolGuideSection,
  type CanonicalSectionId,
  type ProtocolGuideSectionId,
} from "./protocol-guide-sections";

type ProtocolGuideSection = {
  id: CanonicalSectionId;
  navLabel: string;
  headline: string;
  lines: string[];
  tlDr: string;
  image: string;
  imageAlt: string;
};

const sections: ProtocolGuideSection[] = [
  {
    id: "welcome",
    navLabel: "Welcome",
    headline: "Welcome to Valcore. This is an epoch-based strategy competition protocol.",
    lines: [
      "You build a strategy allocation for the epoch.",
      "When the epoch locks, a starting price is recorded.",
      "Live prices update continuously.",
      "Your Epoch Score changes in real time.",
      "Positions score differently.",
      "You have limited tactical reallocations.",
      "This is not about chasing pumps.",
      "It is about building structure.",
    ],
    tlDr: "Build structure. Do not chase candles.",
    image: "/protocol-guide/1.png",
    imageAlt: "Valcore protocol-guide section 1 visual",
  },
  {
    id: "capital-protection",
    navLabel: "Capital Model",
    headline: "Your capital is not fully exposed.",
    lines: [
      "When you deposit, a protected portion stays safe.",
      "A performance portion enters the epoch competition pool.",
      "If the epoch goes badly, only the risk portion is affected.",
      "If the epoch goes well, you earn from the pool based on your score.",
    ],
    tlDr: "Limited downside. Performance-based upside.",
    image: "/protocol-guide/2.png",
    imageAlt: "Valcore protocol-guide section 2 visual",
  },
  {
    id: "weekly-lock-entry",
    navLabel: "Lock Logic",
    headline: "Lock is the starting whistle.",
    lines: [
      "A start price snapshot is recorded when the epoch begins.",
      "Every coin tracks live price versus lock price.",
      "Slot cards show real-time performance.",
      "If you reallocate, previous coin PnL is realized.",
      "The new coin starts from the reallocation price.",
      "Your cumulative epoch score continues.",
      "Reallocation does not reset your epoch timeline.",
    ],
    tlDr: "A reallocation is not undo. It is a new entry point.",
    image: "/protocol-guide/3.png",
    imageAlt: "Valcore protocol-guide section 3 visual",
  },
  {
    id: "formation-roles",
    navLabel: "Formation",
    headline: "Formation defines impact.",
    lines: [
      "Each role reacts differently to profit and loss.",
      "Anchor is the foundation with strong downside sensitivity.",
      "Guardians are the defensive line for downside control.",
      "Operators provide balanced exposure.",
      "Raiders focus on tactical upside potential.",
      "You are not just picking coins.",
      "You are deciding where risk lives.",
    ],
    tlDr: "Choose where your risk belongs.",
    image: "/protocol-guide/4.png",
    imageAlt: "Valcore protocol-guide section 4 visual",
  },
  {
    id: "relative-scoring",
    navLabel: "Relative Score",
    headline: "You do not need a green market to win.",
    lines: [
      "Performance is measured relative to epoch market average.",
      "Universe average PnL is marketAvg.",
      "Slot PnL is slotPnl.",
      "Relative performance is slotPnl minus marketAvg.",
      "Role multipliers and salary weight are then applied.",
      "If market is down but you drop less, you can score positive.",
    ],
    tlDr: "Outperform the field, not the chart.",
    image: "/protocol-guide/5.png",
    imageAlt: "Valcore protocol-guide section 5 visual",
  },
  {
    id: "role-multipliers",
    navLabel: "Multipliers",
    headline: "Multipliers define the protocol.",
    lines: [
      "Each role converts PnL into score differently.",
      "Anchor applies stronger loss penalties and lower gain reward.",
      "Guardians lean defensive.",
      "Operators are balanced.",
      "Raiders amplify upside and soften downside.",
      "Formation is a risk distribution system.",
    ],
    tlDr: "Decide who absorbs impact and who amplifies upside.",
    image: "/protocol-guide/6.png",
    imageAlt: "Valcore protocol-guide section 6 visual",
  },
  {
    id: "salary-power-cap",
    navLabel: "Budget",
    headline: "Budget is strategy.",
    lines: [
      "Every coin has an epoch salary.",
      "Your strategy allocation must fit inside the Power Cap.",
      "Higher salary means greater score weight.",
      "Spending more does not guarantee success.",
      "Smart allocation wins.",
    ],
    tlDr: "Spend wisely. Allocate strategically.",
    image: "/protocol-guide/7.png",
    imageAlt: "Valcore protocol-guide section 7 visual",
  },
  {
    id: "live-price-feedback",
    navLabel: "Live Feedback",
    headline: "Live price is the heartbeat.",
    lines: [
      "What you will see on slot cards (epoch active):",
      "Live Price (updates frequently).",
      "Change since Lock (your epoch reference).",
      "Color state: green when above lock, red when below lock.",
      "Why it is shown this way:",
      "Lock price is the only reference that matters for the epoch outcome.",
      "Live price is shown to help you track your allocation at a glance.",
      "What you will see in Asset Pool (epoch active):",
      "A clean list built for browsing, not signals.",
      "Power / Risk / Momentum tags are labels for the protocol layer only.",
      "They are not financial advice and not guarantees.",
      "Keep it simple:",
      "During the epoch: watch Live vs Lock.",
      "Before you reallocate: use your own research tools if you want (charts, news, etc.).",
    ],
    tlDr: "See the market clearly. Keep the UI calm. You decide the move.",
    image: "/protocol-guide/8.png",
    imageAlt: "Valcore protocol-guide section 8 visual",
  },
  {
    id: "tactical-moves",
    navLabel: "Tactical Moves",
    headline: "Reallocations are limited. Use them strategically.",
    lines: [
      "During active epoch, moves are limited.",
      "Each reallocation consumes one move.",
      "Each reallocation locks realized PnL.",
      "Reallocation Mode means tactical adjustment, not rebuild.",
    ],
    tlDr: "Adjust. Do not overtrade.",
    image: "/protocol-guide/9.png",
    imageAlt: "Valcore protocol-guide section 9 visual",
  },
  {
    id: "movers-radar",
    navLabel: "Movers",
    headline: "Movers show pressure.",
    lines: [
      "During active epoch you get top gainers and losers.",
      "Order updates live.",
      "Each row shows logo, symbol, percentage and live price.",
      "Role indicator gives context.",
      "This panel is your market radar.",
    ],
    tlDr: "Observe first. Act second.",
    image: "/protocol-guide/10.png",
    imageAlt: "Valcore protocol-guide section 10 visual",
  },
  {
    id: "swap-flow",
    navLabel: "Swap Flow",
    headline: "Click a mover. The board guides you.",
    lines: [
      "When you pick a mover, relevant role group highlights.",
      "Eligible slots show reallocation indicators.",
      "You confirm substitution.",
      "No guessing: board shows exactly where it fits.",
    ],
    tlDr: "The system guides the change.",
    image: "/protocol-guide/11.png",
    imageAlt: "Valcore protocol-guide section 11 visual",
  },
  {
    id: "closing",
    navLabel: "Closing",
    headline: "This is not a bull market gimmick.",
    lines: [
      "The protocol rewards structure, discipline and risk management.",
      "Relative performance matters more than market direction.",
      "You do not need market up-only conditions to win.",
      "Build strategy, manage risk, win the epoch.",
    ],
    tlDr: "Structure wins seasons.",
    image: "/protocol-guide/12.png",
    imageAlt: "Valcore protocol-guide section 12 visual",
  },
];

type ProtocolGuideModalProps = {
  open: boolean;
  initialSection?: ProtocolGuideSectionId;
  onClose: () => void;
};

export function ProtocolGuideModal({ open, initialSection = "welcome", onClose }: ProtocolGuideModalProps) {
  const [activeSection, setActiveSection] = useState<CanonicalSectionId>("welcome");

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveSection(normalizeProtocolGuideSection(initialSection));
  }, [initialSection, open]);

  const currentSection = useMemo(
    () => sections.find((section) => section.id === activeSection) ?? sections[0],
    [activeSection],
  );

  if (!open) return null;

  return (
    <div className="htp-overlay" role="dialog" aria-modal="true" aria-labelledby="htp-title">
      <div className="htp-backdrop" onClick={onClose} />

      <div className="htp-modal">
        <div className="htp-topbar">
          <div>
            <div className="htp-kicker">In-Context Guide</div>
            <h2 id="htp-title" className="htp-title">
              How the Protocol Works
            </h2>
          </div>
          <div className="htp-actions">
            <button type="button" className="htp-btn" onClick={onClose}>
              Back to Strategy Board
            </button>
            <button type="button" className="htp-close" aria-label="Close" onClick={onClose}>
              X
            </button>
          </div>
        </div>

        <div className="htp-body">
          <nav className="htp-nav" aria-label="Protocol guide sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`htp-nav-item ${activeSection === section.id ? "active" : ""}`}
                onClick={() => setActiveSection(section.id)}
              >
                {section.navLabel}
              </button>
            ))}
          </nav>

          <div className="htp-content">
            <section className="htp-section" data-section-id={currentSection.id}>
              <p className="htp-headline">{currentSection.headline}</p>
              <ul className="htp-tips">
                {currentSection.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="htp-note htp-tldr">
                <span className="htp-tldr-label">TL;DR</span>
                <span className="htp-tldr-text">{currentSection.tlDr}</span>
              </p>
              <div className="htp-section-media">
                <img
                  className="htp-section-image"
                  src={currentSection.image}
                  alt={currentSection.imageAlt}
                  loading="lazy"
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}


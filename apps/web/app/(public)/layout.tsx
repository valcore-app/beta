import { Inter, Space_Grotesk } from "next/font/google";
import { Hud } from "../../components/site/hud";
import { HudProvider } from "../../components/site/hud-context";
import "./lineup/lineup.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <HudProvider>
      <div className={`lineup-c ${spaceGrotesk.variable} ${inter.variable}`}>
        <div className="vc-atmosphere" aria-hidden="true" />
        <Hud />
        {children}
      </div>
    </HudProvider>
  );
}

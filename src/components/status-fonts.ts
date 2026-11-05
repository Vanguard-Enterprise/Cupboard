import {
  IBM_Plex_Sans,
  Inter,
  JetBrains_Mono,
  Manrope,
  Source_Serif_4,
  Space_Grotesk,
} from "next/font/google";
import type { StatusFont } from "@/lib/status-page";

// Fonts download only when a page uses them, so none are preloaded.
const inter = Inter({ subsets: ["latin"], preload: false });
const manrope = Manrope({ subsets: ["latin"], preload: false });
const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  preload: false,
});
const grotesk = Space_Grotesk({ subsets: ["latin"], preload: false });
const serif = Source_Serif_4({ subsets: ["latin"], preload: false });
const mono = JetBrains_Mono({ subsets: ["latin"], preload: false });

export const statusFontFamily: Record<StatusFont, string> = {
  geist: "var(--font-geist-sans)",
  inter: inter.style.fontFamily,
  manrope: manrope.style.fontFamily,
  "ibm-plex-sans": plex.style.fontFamily,
  "space-grotesk": grotesk.style.fontFamily,
  "source-serif": serif.style.fontFamily,
  "jetbrains-mono": mono.style.fontFamily,
};

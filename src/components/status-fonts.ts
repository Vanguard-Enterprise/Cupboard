import localFont from "next/font/local";
import type { StatusFont } from "@/lib/status-page";

// Fonts ship with npm packages so builds never download them. They load only
// when a page uses them, so none are preloaded.
const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  preload: false,
});
const manrope = localFont({
  src: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
  weight: "200 800",
  preload: false,
});
const plex = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
      weight: "400",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
      weight: "500",
    },
    {
      path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
      weight: "600",
    },
  ],
  preload: false,
});
const grotesk = localFont({
  src: "../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  weight: "300 700",
  preload: false,
});
const serif = localFont({
  src: "../../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2",
  weight: "200 900",
  preload: false,
});
const mono = localFont({
  src: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  preload: false,
});

export const statusFontFamily: Record<StatusFont, string> = {
  geist: "var(--font-geist-sans)",
  inter: inter.style.fontFamily,
  manrope: manrope.style.fontFamily,
  "ibm-plex-sans": plex.style.fontFamily,
  "space-grotesk": grotesk.style.fontFamily,
  "source-serif": serif.style.fontFamily,
  "jetbrains-mono": mono.style.fontFamily,
};

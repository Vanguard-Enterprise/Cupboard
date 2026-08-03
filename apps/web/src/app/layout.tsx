import type { Metadata } from "next";
import "./globals.css";
import { cookies } from "next/headers";
import { DirectionProvider } from "@/components/ui/direction";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Cupboard",
  description: "Cupboard — Rust server network management",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const direction = (await cookies()).get("cb_direction")?.value === "rtl" ? "rtl" : "ltr";
  return (
    <html lang="en" dir={direction} className="font-sans">
      <body>
        <DirectionProvider dir={direction} direction={direction}>
          <TooltipProvider>{children}</TooltipProvider>
        </DirectionProvider>
      </body>
    </html>
  );
}

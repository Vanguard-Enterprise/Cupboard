import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cupboard",
  description: "Cupboard — Rust server network management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Athena",
  description: "AI Executive Assistant with Voice",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

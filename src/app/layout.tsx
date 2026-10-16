import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PraxelOps — AI Infrastructure Operations Platform",
  description:
    "AI-powered infrastructure operations platform with a premium macOS-inspired desktop and web interface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body className="antialiased select-none">{children}</body>
    </html>
  );
}

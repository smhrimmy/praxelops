import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "PraxelOps — AI Infrastructure Operations Platform",
  description:
    "AI-powered infrastructure operations platform with a premium macOS-inspired desktop and web interface",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="antialiased select-none">
        {/* Applies the stored (or OS-preferred) theme before first paint; see public/theme-boot.js. */}
        <Script src="/theme-boot.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}

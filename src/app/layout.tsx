import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SidebarLayout } from "@/components/SidebarLayout";
import { ToastProvider } from "@/components/ui/Toast";
import { SessionProvider } from "@/components/SessionProvider";
import { ThemeProvider } from "@/lib/themes/provider";
import { resolveColors, uiPaletteToCssVars } from "@/lib/themes/presets";
import { loadAppearancePreferences } from "@/lib/themes/server";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ManageT — Server Management Terminal",
  description: "SSH terminal manager with session recovery and monitoring",
};

// viewportFit: "cover" lets the layout extend under the iOS notch/home
// indicator so `env(safe-area-inset-*)` returns real values — the
// mobile bottom nav uses that inset for its bottom padding.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve the user's theme server-side so the first paint already
  // carries their palette. Without this, the client ThemeProvider boots
  // with the default purple and only swaps to the saved theme after an
  // async /api/preferences fetch — a visible "everything is purple"
  // flash on every hard load, worst on slow pages (server detail,
  // group mosaic). The inline <style> overrides the `@theme` defaults
  // from globals.css until the provider takes over for live edits.
  const initialPrefs = await loadAppearancePreferences();
  const themeCss = `:root{${uiPaletteToCssVars(resolveColors(initialPrefs).ui)}}`;

  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <head>
        <style
          id="mg-theme-ssr"
          dangerouslySetInnerHTML={{ __html: themeCss }}
        />
      </head>
      <body className="min-h-full bg-mg-bg text-mg-text font-sans">
        <SessionProvider>
          <ThemeProvider initialPrefs={initialPrefs}>
            <ToastProvider>
              <SidebarLayout>{children}</SidebarLayout>
            </ToastProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}

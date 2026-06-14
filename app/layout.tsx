import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orients Ops Console",
  description: "Internal operations console for Orients field teams.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}

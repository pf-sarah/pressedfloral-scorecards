import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pressed Floral - Scorecards",
  description: "Pressed Floral scorecards app",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}

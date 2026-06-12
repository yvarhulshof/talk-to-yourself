import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Talk to Yourself",
  description:
    "A conversation with an AI that slowly becomes you.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "A first-person cartoon boxing match where every movement, hit, dodge, and parry becomes a painting.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "Boxing Canvas",
    description,
    metadataBase: new URL(origin),
    openGraph: {
      title: "Boxing Canvas",
      description,
      type: "website",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1536,
          height: 1024,
          alt: "Boxing Canvas first-person cartoon boss fight",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Boxing Canvas",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

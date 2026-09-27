import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "squat counter", description: "Count squats with the phone motion sensor" };
export const viewport: Viewport = { themeColor: "#07151b", viewportFit: "cover" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }

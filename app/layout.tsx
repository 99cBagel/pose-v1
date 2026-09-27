import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Get Ready, V1 Target", description: "Follow instruction to get yourself in ready pose" };
export const viewport: Viewport = { themeColor: "#07151b", viewportFit: "cover" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }

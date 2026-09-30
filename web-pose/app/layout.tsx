import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "start-my-workout", description: "Session launcher and pose camera client" };
export const viewport: Viewport = { themeColor: "#07151b", viewportFit: "cover" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }

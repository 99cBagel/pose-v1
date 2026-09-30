"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";

const MOTION_URL = process.env.NEXT_PUBLIC_MOTION_URL ?? "https://pose-motion.vercel.app";

function joinLink(base: string, session: string, token: string) {
  const s = session.trim(), t = token.trim();
  if (!s || !t) return base;
  return `${base}?session=${encodeURIComponent(s)}&token=${encodeURIComponent(t)}`;
}

function ClientCard({
  title, instruction, base, accent, initialSession, initialToken,
}: { title: string; instruction: string; base: string; accent: string; initialSession: string; initialToken: string }) {
  const [session, setSession] = useState(initialSession);
  const [token, setToken] = useState(initialToken);
  const link = useMemo(() => joinLink(base, session, token), [base, session, token]);
  return (
    <section className="launch-card">
      <h2>{title}</h2>
      <p className="launch-instruction">{instruction}</p>
      <label className="launch-field">
        Session code
        <input value={session} onChange={(e) => setSession(e.target.value)} placeholder="e.g. a1b2c3" autoComplete="off" />
      </label>
      <label className="launch-field">
        Client token
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="wct_…" autoComplete="off" />
      </label>
      <div className="launch-row">
        <a className="launch-open" style={{ background: accent }} href={link}>Open client</a>
      </div>
      <div className="launch-qr">
        <QRCodeSVG value={link} size={148} bgColor="#ffffff" fgColor="#000000" />
        <span>Scan to open{session.trim() && token.trim() ? " with this session" : ""}</span>
      </div>
    </section>
  );
}

function LauncherInner() {
  // Deep links from start_workout_session carry ?session=..&token=.. —
  // prefill both cards so the tablet shows the iPhone QR with no typing.
  const params = useSearchParams();
  const preSession = params.get("session") ?? "";
  const preToken = params.get("token") ?? "";
  return (
    <main className="shell">
      <div className="phone">
        <div className="heading">
          <h1>start-my-workout</h1>
          <p>Session launcher — open each client on its device, or scan the QR.</p>
        </div>
        <ClientCard
          title="Tablet · Pose camera"
          instruction="Open the link on this tablet, and set the tablet on the ground facing you."
          base="/pose"
          accent="#70e2e6"
          initialSession={preSession}
          initialToken={preToken}
        />
        <ClientCard
          title="iPhone · Motion sensor"
          instruction="Need to start motion sensor, use iPhone to scan. Put iPhone in pocket."
          base={MOTION_URL}
          accent="#ffd38c"
          initialSession={preSession}
          initialToken={preToken}
        />
      </div>
    </main>
  );
}

export default function Launcher() {
  return (
    <Suspense>
      <LauncherInner />
    </Suspense>
  );
}

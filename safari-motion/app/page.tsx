import { Suspense } from "react";
import { MotionClientView } from "./components/MotionClient";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="shell">
          <div className="phone">
            <p className="hint">loading…</p>
          </div>
        </div>
      }
    >
      <MotionClientView />
    </Suspense>
  );
}

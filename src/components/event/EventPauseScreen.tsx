"use client";
import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useEventState } from "./EventState";
import styles from "./EventPause.module.css";

function PauseCountdown({ deadline }: { deadline: string }) {
  const { clockOffset } = useEventState();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffset);
    tick();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clockOffset]);

  const end = Date.parse(deadline);
  const remaining =
    now === null || !Number.isFinite(end)
      ? null
      : Math.max(0, Math.ceil((end - now) / 1000));
  const display =
    remaining === null
      ? "--:--:--"
      : [
          Math.floor(remaining / 3600),
          Math.floor((remaining % 3600) / 60),
          remaining % 60,
        ]
          .map((part) => String(part).padStart(2, "0"))
          .join(":");

  return (
    <div className={styles.countdown}>
      <p className={styles.note}>RESUMING IN</p>
      <div
        className={styles.digits}
        role="timer"
        aria-live="off"
        aria-label={`Time remaining: ${display}`}
      >
        {display}
      </div>
      {remaining === 0 && (
        <p role="status">Waiting for the server to confirm resumption…</p>
      )}
    </div>
  );
}

export default function EventPauseScreen() {
  const { config, ready, refresh } = useEventState();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const checkStatus = async () => {
    setChecking(true);
    setMessage("");
    const ok = await refresh();
    setMessage(
      ok
        ? "Status checked. The event is still paused."
        : "Could not check status. Check your connection and try again.",
    );
    setChecking(false);
  };
  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <p className={styles.label}>CTFrbt / EVENT STATUS</p>
        {ready && (
          <pre className={styles.tree} aria-hidden="true">
            {"   *\n  /\\\n /__\\\n/____\\\n  ||"}
          </pre>
        )}
        <h1>{ready ? "EVENT PAUSED" : "CONNECTING…"}</h1>
        <p>
          {ready
            ? "Take a break. Challenges and submissions are temporarily unavailable."
            : "Checking the competition status."}
        </p>
        {ready && config?.pausedUntil && (
          <PauseCountdown deadline={config.pausedUntil} />
        )}
        {ready && config?.pausedUntil && (
          <p>
            Resumes at{" "}
            <strong>
              {new Date(config.pausedUntil).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </strong>{" "}
            (your local time)
          </p>
        )}
        <p className={styles.note}>This view updates automatically.</p>
        {message && <p role="status">{message}</p>}
        <div className={styles.actions}>
          <button
            className="btn"
            disabled={checking}
            onClick={() => void checkStatus()}
          >
            {checking ? "Checking…" : "Check status"}
          </button>
          <button
            className="btn"
            onClick={() => void signOut({ callbackUrl: "/auth/signin" })}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

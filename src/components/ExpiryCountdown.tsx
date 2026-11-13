"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live countdown to an expiration timestamp (#7). Renders nothing until
 * `expiresAt` is set, the remaining time while it is in the future, and
 * "expired" once it passes. The caller styles the span. `onExpired` fires
 * once when the deadline passes, so the caller can refetch server state.
 */
export default function ExpiryCountdown({
  expiresAt,
  label = "expires in",
  onExpired,
}: {
  expiresAt: string | null;
  label?: string;
  onExpired?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const expiredFired = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = expiresAt != null && new Date(expiresAt).getTime() <= now;

  useEffect(() => {
    if (expired && !expiredFired.current) {
      expiredFired.current = true;
      onExpired?.();
    }
  }, [expired, onExpired]);

  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) {
    return <span>expired</span>;
  }
  const totalMinutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  const hours = Math.floor(totalMinutes / 60);
  const text =
    hours > 0
      ? `${hours}h ${totalMinutes % 60}m`
      : `${totalMinutes}m ${seconds}s`;
  return (
    <span>
      {label} {text}
    </span>
  );
}

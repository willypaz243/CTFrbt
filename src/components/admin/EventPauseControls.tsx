"use client";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useEventState } from "../event/EventState";

export default function EventPauseControls() {
  const { config, paused, refresh, ready, clockOffset } = useEventState();
  const [minutes, setMinutes] = useState("60");
  const [saving, setSaving] = useState(false);
  const [suspendInstances, setSuspendInstances] = useState(false);
  const [status, setStatus] = useState<{
    controllerOnline: boolean;
    states: Record<string, number>;
    errors: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/admin/instance-pause", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (active) setStatus(data);
      } catch {
        if (active) setStatus(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const changePause = async (adjustment?: number) => {
    const duration = Number(minutes);
    if (
      !paused &&
      (!Number.isInteger(duration) || duration < 1 || duration > 1440)
    ) {
      toast.error("Choose a duration between 1 and 1440 minutes");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/admin/game", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          adjustment !== undefined
            ? { action: "adjust", minutes: adjustment }
            : paused
              ? { action: "resume" }
              : { action: "pause", minutes: duration, suspendInstances },
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error || "Could not update pause");
        return;
      }
      await refresh();
      toast.success(
        adjustment !== undefined
          ? "Pause updated"
          : paused
            ? "Event resumed"
            : "Event paused",
      );
    } catch {
      toast.error("Could not update pause");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="card"
      aria-labelledby="event-pause-title"
      style={{ marginTop: 16 }}
    >
      <h2 id="event-pause-title" style={{ fontSize: 14, marginBottom: 12 }}>
        Event pause
      </h2>
      <p
        style={{
          fontSize: 12,
          color: paused ? "var(--warning)" : "var(--fg-muted)",
          marginBottom: 12,
        }}
      >
        {paused && config?.pausedUntil
          ? `PAUSED — resumes at ${new Date(config.pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} (local time)`
          : "Hide event content and block participant actions during a break."}
      </p>
      {!paused && (
        <label style={{ display: "block", fontSize: 12, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={suspendInstances}
            disabled={saving}
            onChange={(event) => setSuspendInstances(event.target.checked)}
          />{" "}
          Also suspend participant instances (preserve remaining TTL)
        </label>
      )}
      <p
        style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 12 }}
        role="status"
      >
        Instance controller:{" "}
        {status
          ? status.controllerOnline
            ? "online"
            : "offline — suspension/resume may be pending"
          : "status unavailable"}
        .
        {status &&
          ` Suspended: ${status.states.SUSPENDED ?? 0}, suspending: ${status.states.SUSPENDING ?? 0}, resuming: ${status.states.RESUMING ?? 0}, errors: ${status.errors}.`}
        {paused &&
          config?.suspendInstances &&
          status &&
          ` Still running/starting: ${(status.states.RUNNING ?? 0) + (status.states.STARTING ?? 0)}.`}
      </p>
      <div
        style={{
          display: "flex",
          alignItems: "end",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        {!paused && (
          <label style={{ fontSize: 12 }}>
            Duration (minutes)
            <input
              className="form-input"
              type="number"
              min="1"
              max="1440"
              step="1"
              value={minutes}
              disabled={saving}
              onChange={(e) => setMinutes(e.target.value)}
              style={{ display: "block", width: 160, marginTop: 6 }}
            />
          </label>
        )}
        {paused && (
          <>
            <button
              type="button"
              className="btn"
              disabled={
                saving ||
                !config?.pausedUntil ||
                Date.parse(config.pausedUntil) - (Date.now() + clockOffset) <=
                  300_000
              }
              onClick={() => void changePause(-5)}
            >
              −5 minutes
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                saving ||
                (!!config?.endTime &&
                  !!config.pausedUntil &&
                  Date.parse(config.pausedUntil) >= Date.parse(config.endTime))
              }
              onClick={() => void changePause(5)}
            >
              +5 minutes
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !ready || !config}
          onClick={() => void changePause()}
        >
          {saving ? "Saving…" : paused ? "Resume event" : "Pause event"}
        </button>
      </div>
      <p
        style={{
          fontSize: 11,
          color: "var(--fg-muted)",
          marginTop: 12,
          lineHeight: 1.6,
        }}
      >
        Resumes automatically. The competition end time stays unchanged; the
        break cannot extend past it. Administrators keep access. Downloaded
        files and external services cannot be suspended. The optional controller
        freezes participant containers in batches; admin test instances stay
        available. Check the counts above before considering suspension
        complete.
      </p>
    </section>
  );
}

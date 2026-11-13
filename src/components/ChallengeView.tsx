"use client";

import { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import ExpiryCountdown from "@/components/ExpiryCountdown";
import { hostPortFromUrl } from "@/lib/host-port";
import {
  FiDownload,
  FiLock,
  FiCheck,
  FiHelpCircle,
  FiPlay,
  FiSquare,
} from "react-icons/fi";

export interface ChallengeFile {
  id: string;
  name: string;
  size: number;
}

export interface HintData {
  id: string;
  cost: number;
  purchased: boolean;
  content: string | null;
}

export interface FlagData {
  id: string;
  points: number;
  isSolved: boolean;
}

/** The team's instance of a dynamic challenge (#5), if any. */
export interface InstanceData {
  state: string; // NOT_STARTED | STARTING | RUNNING | STOPPED | EXPIRED | FAILED
  accessUrl: string | null;
  expiresAt: string | null;
  startCount: number;
  lastLog?: string | null;
  sshUser?: string | null;
  sshPass?: string | null;
  containerPort?: number | null;
}

export interface ChallengeData {
  id: string;
  title: string;
  description: string;
  points: number;
  category: string;
  difficulty: string;
  isLocked: boolean;
  isSolved: boolean;
  solveCount: number;
  multipleFlags: boolean;
  link: string | null;
  files: ChallengeFile[];
  // Dynamic challenge (#5): absent/undefined on static challenges.
  isDynamic?: boolean;
  buildState?: string | null;
  instance?: InstanceData | null;
  hintCount: number;
  flags: FlagData[];
}

/**
 * Team instance controls for a dynamic challenge (#5): start the team's
 * container, see its state and access URL, stop it. One per team.
 */
function InstancePanel({
  challenge,
  onRefresh,
}: {
  challenge: ChallengeData;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(challenge.instance ?? null);
  // The client-side countdown hit zero but the server state has not been
  // swept yet — show "stopping" feedback and refetch (the read triggers
  // the throttled sweep on the server, #7).
  const [expiring, setExpiring] = useState(false);

  // Poll while the instance is starting (the container takes a moment).
  const polling = live?.state === "STARTING";
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/challenges/${challenge.id}/instance`);
      if (res.ok) {
        const data = (await res.json()) as { instance: InstanceData };
        setLive(data.instance);
      }
    } catch {
      /* keep the previous state */
    }
  }, [challenge.id]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [polling, poll]);

  // The deadline passed client-side: refetch so the server sweeps the
  // instance, and keep the "stopping" feedback up until the state moves.
  const handleExpired = useCallback(() => {
    setExpiring(true);
    poll();
    onRefresh();
  }, [poll, onRefresh]);

  // The server sweep is throttled to one per 60 s, so a read right after
  // the deadline can predate the next sweep — keep polling until the
  // state moves (EXPIRED/STOPPED) so the feedback cannot get stuck.
  useEffect(() => {
    if (!expiring) return;
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [expiring, poll]);

  useEffect(() => {
    setLive(challenge.instance ?? null);
  }, [challenge.instance]);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.id}/instance`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        instance?: InstanceData;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Failed to start instance");
        return;
      }
      setLive(data.instance ?? null);
      toast.success("Instance starting");
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.id}/instance`, {
        method: "DELETE",
      });
      const data = (await res.json()) as {
        instance?: InstanceData;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Failed to stop instance");
        return;
      }
      setLive(data.instance ?? null);
      toast.success("Instance stopped");
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  };

  const imageReady = challenge.buildState === "READY";
  const state = live?.state ?? "NOT_STARTED";
  const running = state === "RUNNING";

  // Clear the "stopping" feedback once the server state has moved on.
  useEffect(() => {
    if (state !== "RUNNING" && state !== "STARTING") setExpiring(false);
  }, [state]);

  return (
    <div
      style={{
        marginBottom: "24px",
        padding: "12px",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: "12px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: "var(--fg-dim)",
          }}
        >
          Your instance
        </span>
        <span
          style={{
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            color: running
              ? "var(--success)"
              : state === "FAILED"
                ? "var(--danger)"
                : "var(--fg-muted)",
          }}
        >
          {state.toLowerCase().replace("_", " ")}
          {live && live.startCount > 1 && ` (start #${live.startCount})`}
        </span>
        {(state === "RUNNING" || state === "STARTING") && live?.expiresAt && (
          <span
            style={{
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color:
                expiring ||
                new Date(live.expiresAt).getTime() - Date.now() < 5 * 60_000
                  ? "var(--danger)"
                  : "var(--fg-muted)",
            }}
          >
            {expiring ? (
              "expiring — stopping instance…"
            ) : (
              <ExpiryCountdown
                expiresAt={live.expiresAt}
                onExpired={handleExpired}
              />
            )}
          </span>
        )}

        {running && live?.accessUrl && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontFamily: "var(--font-mono)",
              color: "var(--fg-muted)",
            }}
          >
            {hostPortFromUrl(live.accessUrl)}
            {live.containerPort === 22 && live.sshUser && live.sshPass && (
              <span style={{ color: "var(--fg-dim)" }}>
                — {live.sshUser} / {live.sshPass}
              </span>
            )}
          </span>
        )}

        <span style={{ marginLeft: "auto" }}>
          {!imageReady ? (
            <span style={{ fontSize: "12px", color: "var(--fg-dim)" }}>
              image not built
            </span>
          ) : running || state === "STARTING" ? (
            <button
              className="btn"
              disabled={busy}
              onClick={stop}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
              }}
            >
              <FiSquare size={12} />
              {busy ? "..." : "Stop"}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={start}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
              }}
            >
              <FiPlay size={12} />
              {busy ? "..." : "Start instance"}
            </button>
          )}
        </span>
      </div>
      {state === "FAILED" && live?.lastLog && (
        <pre
          style={{
            marginTop: "8px",
            maxHeight: "140px",
            overflow: "auto",
            fontSize: "11px",
            color: "var(--danger)",
          }}
        >
          {String(live.lastLog).slice(-2000)}
        </pre>
      )}
    </div>
  );
}

export default function ChallengeView({
  challenge,
  onSolved,
  hasTeam,
  onInstanceChanged,
}: {
  challenge: ChallengeData;
  onSolved?: () => void;
  /** Players without a team don't see the instance panel (#5). */
  hasTeam?: boolean;
  onInstanceChanged?: () => void;
}) {
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [hints, setHints] = useState<HintData[]>([]);
  const [hintsLoaded, setHintsLoaded] = useState(false);
  const [showHints, setShowHints] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!flag.trim()) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, flag: flag.trim() }),
      });

      const data = await res.json();

      if (res.status === 429) {
        toast.error(data.error);
        return;
      }

      if (!res.ok) {
        toast.error(data.error || "Submission failed");
        return;
      }

      if (data.correct) {
        if (data.alreadySubmitted) {
          toast("Already submitted", { icon: "ℹ️" });
        } else {
          toast.success(`+${data.points} pts — ${data.message}`);
          onSolved?.();
        }
      } else {
        toast.error(data.message || "Incorrect");
      }

      setFlag("");
    } catch {
      toast.error("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const loadHints = async () => {
    if (hintsLoaded) {
      setShowHints(!showHints);
      return;
    }

    try {
      const res = await fetch(`/api/hints?challengeId=${challenge.id}`);
      const data = await res.json();
      setHints(data.hints || []);
      setHintsLoaded(true);
      setShowHints(true);
    } catch {
      toast.error("Failed to load hints");
    }
  };

  const purchaseHint = async (hintId: string) => {
    try {
      const res = await fetch("/api/hints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hintId }),
      });

      const data = await res.json();

      if (!res.ok && res.status !== 200) {
        toast.error(data.error || "Failed to purchase hint");
        return;
      }

      // Update hint in state
      setHints((prev) =>
        prev.map((h) =>
          h.id === hintId
            ? { ...h, purchased: true, content: data.content }
            : h,
        ),
      );

      if (data.cost > 0) {
        toast(`Hint purchased (-${data.cost} pts)`, { icon: "💡" });
        onSolved?.();
      }
    } catch {
      toast.error("Network error");
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (challenge.isLocked) {
    return (
      <div style={{ padding: "32px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "12px",
          }}
        >
          <FiLock size={20} style={{ color: "var(--warning)" }} />
          <h2 style={{ fontSize: "22px", fontWeight: 700 }}>Locked</h2>
        </div>
        <p style={{ color: "var(--fg-dim)", fontSize: "14px" }}>
          Complete the prerequisite challenges to unlock this one.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          marginBottom: "4px",
        }}
      >
        {challenge.isSolved && (
          <FiCheck size={18} style={{ color: "var(--success)" }} />
        )}
        <h2 style={{ fontSize: "22px", fontWeight: 700 }}>{challenge.title}</h2>
      </div>

      <div
        style={{
          display: "flex",
          gap: "16px",
          fontSize: "12px",
          color: "var(--fg-dim)",
          marginBottom: "24px",
        }}
      >
        <span>{challenge.points} pts</span>
        <span>{challenge.difficulty}</span>
        <span>{challenge.category}</span>
        <span>
          {challenge.solveCount} solve{challenge.solveCount !== 1 ? "s" : ""}
        </span>
      </div>

      <div
        style={{
          marginBottom: "24px",
          fontSize: "14px",
          lineHeight: 1.7,
          color: "var(--fg-muted)",
          whiteSpace: "pre-wrap",
        }}
      >
        {challenge.description}
      </div>

      {/* Team instance for dynamic challenges (#5) — static ones unchanged */}
      {challenge.isDynamic && hasTeam && (
        <InstancePanel
          challenge={challenge}
          onRefresh={onInstanceChanged ?? (() => {})}
        />
      )}

      {challenge.link && (
        <div style={{ marginBottom: "20px" }}>
          <a
            href={challenge.link}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--accent)",
              fontSize: "13px",
              textDecoration: "underline",
            }}
          >
            {challenge.link}
          </a>
        </div>
      )}

      {challenge.files.length > 0 && (
        <div style={{ marginBottom: "24px" }}>
          <h3
            style={{
              fontSize: "12px",
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "1px",
              marginBottom: "8px",
            }}
          >
            Files
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {challenge.files.map((file) => (
              <a
                key={file.id}
                href={`/api/files/${file.id}`}
                download
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 12px",
                  border: "1px solid var(--border)",
                  fontSize: "13px",
                  color: "var(--fg-muted)",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor = "var(--fg)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = "var(--border)")
                }
              >
                <FiDownload size={14} />
                <span>{file.name}</span>
                <span style={{ marginLeft: "auto", color: "var(--fg-dim)" }}>
                  {formatSize(file.size)}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Multi-flag progress */}
      {challenge.multipleFlags && challenge.flags.length > 0 && (
        <div style={{ marginBottom: "24px" }}>
          <h3
            style={{
              fontSize: "12px",
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "1px",
              marginBottom: "8px",
            }}
          >
            Flags ({challenge.flags.filter((f) => f.isSolved).length}/
            {challenge.flags.length})
          </h3>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {challenge.flags.map((f, i) => (
              <div
                key={f.id}
                style={{
                  padding: "4px 10px",
                  border: `1px solid ${f.isSolved ? "var(--success)" : "var(--border)"}`,
                  fontSize: "12px",
                  color: f.isSolved ? "var(--success)" : "var(--fg-dim)",
                }}
              >
                Flag {i + 1} ({f.points}pts) {f.isSolved && "✓"}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Flag submission */}
      {!challenge.isSolved && (
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "20px",
          }}
        >
          <input
            type="text"
            className="form-input"
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            placeholder="flag{...}"
            style={{ flex: 1 }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !flag.trim()}
            style={{ whiteSpace: "nowrap" }}
          >
            {submitting ? "..." : "Submit"}
          </button>
        </form>
      )}

      {/* Hints */}
      {challenge.hintCount > 0 && (
        <div>
          <button
            onClick={loadHints}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "transparent",
              border: "none",
              color: "var(--fg-dim)",
              fontSize: "13px",
              cursor: "pointer",
              padding: "4px 0",
              fontFamily: "var(--font-mono)",
            }}
          >
            <FiHelpCircle size={14} />
            {showHints ? "Hide hints" : `Show hints (${challenge.hintCount})`}
          </button>

          {showHints && (
            <div
              style={{
                marginTop: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              {hints.map((hint, i) => (
                <div
                  key={hint.id}
                  style={{
                    padding: "12px",
                    border: "1px solid var(--border)",
                    fontSize: "13px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: hint.purchased ? "8px" : "0",
                    }}
                  >
                    <span style={{ color: "var(--fg-dim)" }}>Hint {i + 1}</span>
                    {hint.purchased ? (
                      <span
                        style={{ color: "var(--success)", fontSize: "11px" }}
                      >
                        Purchased
                      </span>
                    ) : (
                      <button
                        className="btn"
                        style={{ fontSize: "11px", padding: "3px 10px" }}
                        onClick={() => purchaseHint(hint.id)}
                      >
                        Unlock ({hint.cost > 0 ? `-${hint.cost} pts` : "Free"})
                      </button>
                    )}
                  </div>
                  {hint.purchased && hint.content && (
                    <p
                      style={{
                        color: "var(--fg-muted)",
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.6,
                      }}
                    >
                      {hint.content}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

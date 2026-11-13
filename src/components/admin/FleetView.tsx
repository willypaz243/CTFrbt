"use client";

import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import LoadingSpinner from "../ui/LoadingSpinner";

/** Row shape of GET /api/admin/fleet (story #8). */
interface FleetInstance {
  id: string;
  challenge: { id: string; title: string };
  team: { id: string; name: string };
  state: string;
  accessUrl: string | null;
  containerPort: number | null;
  hostPort: number | null;
  expiresAt: string | null;
  createdAt: string;
  startCount: number;
  containerState: "RUNNING" | "EXITED" | "MISSING" | null;
}

const REFRESH_MS = 5000;

function formatExpiry(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "—";
  const diff = new Date(expiresAt).getTime() - now;
  if (diff <= 0) return "expirada";
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export default function FleetView() {
  const [instances, setInstances] = useState<FleetInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [killBusyId, setKillBusyId] = useState<string | null>(null);

  const loadFleet = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/fleet", { cache: "no-store" });
      if (!res.ok) {
        toast.error("Failed to load fleet");
        return;
      }
      const data = (await res.json()) as { instances: FleetInstance[] };
      setInstances(data.instances ?? []);
    } catch {
      toast.error("Failed to load fleet");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFleet();
    const id = setInterval(() => {
      loadFleet();
      setNow(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadFleet]);

  const kill = useCallback(
    async (instance: FleetInstance) => {
      const ok = window.confirm(
        `¿Matar la instancia de ${instance.team.name} en «${instance.challenge.title}»?`,
      );
      if (!ok) return;
      setKillBusyId(instance.id);
      try {
        const res = await fetch(`/api/admin/fleet/${instance.id}/kill`, {
          method: "POST",
        });
        if (!res.ok) {
          toast.error("Failed to kill instance");
          return;
        }
        toast.success("Instance stopped");
        await loadFleet();
      } catch {
        toast.error("Failed to kill instance");
      } finally {
        setKillBusyId(null);
      }
    },
    [loadFleet],
  );

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <div>
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ fontSize: "16px", fontWeight: 600 }}>
          Fleet ({instances.length})
        </h2>
        <span style={{ fontSize: "12px", opacity: 0.6 }}>
          auto-refresh every 5 s
        </span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Reto</th>
            <th>Equipo</th>
            <th>Estado</th>
            <th>Dirección</th>
            <th>Creada</th>
            <th>Expira en</th>
            <th>Reinicios</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {instances.length === 0 && (
            <tr>
              <td colSpan={8} style={{ textAlign: "center", opacity: 0.6 }}>
                No instances yet.
              </td>
            </tr>
          )}
          {instances.map((i) => (
            <tr key={i.id}>
              <td>{i.challenge.title}</td>
              <td>{i.team.name}</td>
              <td>
                {i.state}
                {i.containerState === "MISSING" && (
                  <span
                    style={{
                      marginLeft: "8px",
                      fontSize: "11px",
                      color: "#e5484d",
                    }}
                  >
                    contenedor ausente
                  </span>
                )}
                {i.containerState === "EXITED" && (
                  <span
                    style={{
                      marginLeft: "8px",
                      fontSize: "11px",
                      color: "#e5a50a",
                    }}
                  >
                    EXITED
                  </span>
                )}
              </td>
              <td>{i.accessUrl ?? "—"}</td>
              <td>{new Date(i.createdAt).toLocaleString()}</td>
              <td>{formatExpiry(i.expiresAt, now)}</td>
              <td>{i.startCount}</td>
              <td>
                {(i.state === "RUNNING" ||
                  i.state === "STARTING" ||
                  i.state === "NOT_STARTED" ||
                  i.state === "FAILED") && (
                  <button
                    className="btn"
                    style={{ color: "#e5484d", borderColor: "#e5484d" }}
                    disabled={killBusyId === i.id}
                    onClick={() => kill(i)}
                  >
                    {killBusyId === i.id ? "…" : "Matar"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import type { FormEvent } from "react";
import { Fragment, useMemo, useState } from "react";
import { useSortableTable } from "@/hooks/useSortableTable";

export interface ChallengeContainerConfig {
  dockerfile: string;
  buildState: "QUEUED" | "BUILDING" | "READY" | "FAILED" | string;
  buildId: string | null;
  imageDigest: string | null;
  buildLog: string | null;
  pendingState: string | null;
  pendingDigest: string | null;
  pendingLog: string | null;
  testState: string | null;
  testAccessUrl: string | null;
  testExpiresAt: string | null;
}

export interface ChallengeFileInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  storedName: string;
}

export interface Challenge {
  id: string;
  title: string;
  category: string;
  points: number;
  difficulty: string;
  isActive: boolean;
  isLocked: boolean;
  containerConfig?: ChallengeContainerConfig | null;
  files?: ChallengeFileInfo[];
  _count: { submissions: number };
}

export interface ChallengeHint {
  content: string;
  cost: number;
}

export interface ChallengeForm {
  title: string;
  description: string;
  points: number;
  flag: string;
  category: string;
  difficulty: string;
  link: string;
  hints: ChallengeHint[];
  mode: "static" | "dynamic";
  dockerfile: string;
}

export interface BuildStatus {
  state: "QUEUED" | "BUILDING" | "READY" | "FAILED" | string;
  log: string | null;
}

interface ChallengesManagementProps {
  challenges: Challenge[];
  showForm: boolean;
  form: ChallengeForm;
  formFiles: File[];
  creating: boolean;
  buildStatus: BuildStatus | null;
  categoryOptions: string[];
  uploadingId: string | null;
  testBusyId: string | null;
  rebuildBusyId: string | null;
  onToggleForm: () => void;
  onFormChange: (form: ChallengeForm) => void;
  onFormFilesChange: (files: File[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleChallenge: (id: string, isActive: boolean) => void;
  onDeleteChallenge: (id: string, title: string) => void;
  onUploadFiles: (challengeId: string, files: File[]) => void;
  onDeleteFile: (challengeId: string, fileId: string) => void;
  onStartTest: (challengeId: string) => void;
  onStopTest: (challengeId: string) => void;
  onRebuild: (challengeId: string, dockerfile: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Expandable panel under a dynamic challenge row: lists the files that go
 * into the image build context and lets the admin upload/remove them.
 */
function ChallengeFilesPanel({
  challenge,
  uploading,
  onUploadFiles,
  onDeleteFile,
}: {
  challenge: Challenge;
  uploading: boolean;
  onUploadFiles: (challengeId: string, files: File[]) => void;
  onDeleteFile: (challengeId: string, fileId: string) => void;
}) {
  const files = challenge.files ?? [];
  return (
    <div style={{ padding: "10px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <span style={{ fontSize: "12px", fontWeight: 600 }}>
          Files (image build context)
        </span>
        <label
          className="btn"
          style={{
            fontSize: "11px",
            padding: "4px 8px",
            cursor: uploading ? "default" : "pointer",
            margin: 0,
          }}
        >
          {uploading ? "Uploading..." : "Upload files"}
          <input
            type="file"
            multiple
            hidden
            disabled={uploading}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length > 0) onUploadFiles(challenge.id, picked);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <div
        style={{
          fontSize: "11px",
          color: "var(--fg-dim)",
          marginBottom: "8px",
        }}
      >
        The Dockerfile must COPY these files by their exact (stored) name.
      </div>
      {files.length === 0 ? (
        <span style={{ fontSize: "12px", color: "var(--fg-dim)" }}>
          No files uploaded yet.
        </span>
      ) : (
        files.map((file) => (
          <div
            key={file.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "4px",
              fontSize: "12px",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)" }} title={file.name}>
              {file.storedName}
            </span>
            <span style={{ color: "var(--fg-dim)" }}>
              {formatSize(file.size)}
            </span>
            <button
              type="button"
              className="btn"
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                marginLeft: "auto",
              }}
              onClick={() => onDeleteFile(challenge.id, file.id)}
            >
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Dockerfile editor for a dynamic challenge: save a modified Dockerfile to
 * kick a rolling rebuild — the active image keeps serving until the new
 * build is READY.
 */
function DockerfilePanel({
  challenge,
  busy,
  onRebuild,
}: {
  challenge: Challenge;
  busy: boolean;
  onRebuild: (challengeId: string, dockerfile: string) => void;
}) {
  const config = challenge.containerConfig!;
  const [draft, setDraft] = useState(config.dockerfile);
  const rebuilding = config.pendingState === "BUILDING";
  const initialBuildRunning =
    config.buildState === "QUEUED" || config.buildState === "BUILDING";
  const failedLog =
    config.pendingState === "FAILED"
      ? config.pendingLog
      : config.buildState === "FAILED"
        ? config.buildLog
        : null;
  return (
    <div style={{ marginBottom: "10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "6px",
        }}
      >
        <span style={{ fontSize: "12px", fontWeight: 600 }}>Dockerfile</span>
        <span
          style={{
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            color: failedLog
              ? "var(--danger)"
              : rebuilding || initialBuildRunning
                ? "var(--fg-muted)"
                : "var(--success)",
          }}
        >
          {rebuilding
            ? "rebuilding…"
            : failedLog
              ? "last build failed"
              : initialBuildRunning
                ? config.buildState
                : "READY"}
        </span>
        <button
          type="button"
          className="btn"
          style={{
            fontSize: "11px",
            padding: "2px 6px",
            marginLeft: "auto",
            cursor: busy || rebuilding ? "default" : "pointer",
          }}
          disabled={busy || rebuilding}
          onClick={() => onRebuild(challenge.id, draft)}
        >
          {busy ? "Saving..." : "Save & rebuild"}
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          boxSizing: "border-box",
          minHeight: "120px",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
        }}
      />
      {rebuilding && (
        <div
          style={{ fontSize: "11px", color: "var(--fg-dim)", marginTop: "4px" }}
        >
          The current image keeps serving while the new one builds.
        </div>
      )}
      {failedLog && (
        <pre
          style={{
            marginTop: "6px",
            maxHeight: "180px",
            overflow: "auto",
            fontSize: "11px",
            background: "var(--bg-muted, transparent)",
            padding: "6px",
          }}
        >
          {failedLog.slice(-4000)}
        </pre>
      )}
    </div>
  );
}

/**
 * Test instance controls for a dynamic challenge (admin-only): start a
 * short-lived instance from the built image, show its access URL, stop it.
 */
function TestInstancePanel({
  challenge,
  busy,
  onStartTest,
  onStopTest,
}: {
  challenge: Challenge;
  busy: boolean;
  onStartTest: (challengeId: string) => void;
  onStopTest: (challengeId: string) => void;
}) {
  const config = challenge.containerConfig!;
  const running =
    config.testState === "RUNNING" || config.testState === "STARTING";
  const expires = config.testExpiresAt
    ? new Date(config.testExpiresAt).toLocaleTimeString()
    : null;
  return (
    <div
      style={{
        marginTop: "10px",
        paddingTop: "8px",
        borderTop: "1px solid var(--border, #333)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "12px",
        }}
      >
        <span style={{ fontWeight: 600 }}>Test instance:</span>
        {running ? (
          <>
            <span
              style={{
                color: "var(--success)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {config.testState}
            </span>
            {config.testAccessUrl ? (
              <a
                href={config.testAccessUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {config.testAccessUrl}
              </a>
            ) : (
              <span style={{ color: "var(--fg-dim)" }}>no exposed ports</span>
            )}
            {expires && (
              <span style={{ color: "var(--fg-dim)" }}>
                (expires {expires})
              </span>
            )}
            <button
              type="button"
              className="btn"
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                marginLeft: "auto",
              }}
              disabled={busy}
              onClick={() => onStopTest(challenge.id)}
            >
              {busy ? "Stopping..." : "Stop test"}
            </button>
          </>
        ) : (
          <>
            {config.testState && (
              <span
                style={{
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {config.testState}
              </span>
            )}
            {config.buildState === "READY" ? (
              <button
                type="button"
                className="btn"
                style={{
                  fontSize: "11px",
                  padding: "2px 6px",
                  marginLeft: "auto",
                }}
                disabled={busy}
                onClick={() => onStartTest(challenge.id)}
              >
                {busy ? "Starting..." : "Start test"}
              </button>
            ) : (
              <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>
                image not built
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ChallengesManagement({
  challenges,
  showForm,
  form,
  formFiles,
  creating,
  buildStatus,
  categoryOptions,
  uploadingId,
  testBusyId,
  rebuildBusyId,
  onToggleForm,
  onFormChange,
  onFormFilesChange,
  onSubmit,
  onToggleChallenge,
  onDeleteChallenge,
  onUploadFiles,
  onDeleteFile,
  onStartTest,
  onStopTest,
  onRebuild,
}: ChallengesManagementProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sortAccessors = useMemo(
    () => ({
      title: (c: Challenge) => c.title,
      category: (c: Challenge) => c.category,
      points: (c: Challenge) => c.points,
      difficulty: (c: Challenge) => c.difficulty,
      solves: (c: Challenge) => c._count.submissions,
      status: (c: Challenge) => c.isActive,
    }),
    [],
  );

  const { sortedData, getSortIndicator, getThProps } = useSortableTable(
    challenges,
    { key: "title", direction: "asc" },
    sortAccessors,
  );

  return (
    <>
      {/* Challenges header */}
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ fontSize: "16px", fontWeight: 600 }}>
          Challenges ({challenges.length})
        </h2>
        <button className="btn" onClick={onToggleForm}>
          {showForm ? "Cancel" : "+ New Challenge"}
        </button>
      </div>

      {/* New challenge form */}
      {showForm && (
        <div className="card" style={{ marginBottom: "16px" }}>
          <form onSubmit={onSubmit}>
            <div style={{ marginBottom: "10px" }}>
              <select
                className="form-input"
                value={form.mode}
                onChange={(e) =>
                  onFormChange({
                    ...form,
                    mode: e.target.value === "dynamic" ? "dynamic" : "static",
                  })
                }
                style={{ maxWidth: "320px" }}
              >
                <option value="static">Static challenge</option>
                <option value="dynamic">Dynamic challenge (Dockerfile)</option>
              </select>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "10px",
                marginBottom: "10px",
              }}
            >
              <input
                type="text"
                className="form-input"
                value={form.title}
                onChange={(e) =>
                  onFormChange({ ...form, title: e.target.value })
                }
                placeholder="Title"
                required
              />
              <input
                type="text"
                className="form-input"
                value={form.flag}
                onChange={(e) =>
                  onFormChange({ ...form, flag: e.target.value })
                }
                placeholder="flag{...}"
                required
              />
            </div>
            <textarea
              className="form-input"
              value={form.description}
              onChange={(e) =>
                onFormChange({ ...form, description: e.target.value })
              }
              placeholder="Description"
              required
              rows={4}
              style={{ marginBottom: "10px", resize: "vertical" }}
            />
            {form.mode === "dynamic" && (
              <textarea
                className="form-input"
                value={form.dockerfile}
                onChange={(e) =>
                  onFormChange({ ...form, dockerfile: e.target.value })
                }
                placeholder={"Dockerfile\nFROM alpine:3.20\n..."}
                required
                rows={6}
                style={{
                  marginBottom: "10px",
                  resize: "vertical",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                }}
              />
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
                gap: "10px",
                marginBottom: "10px",
              }}
            >
              <input
                type="number"
                className="form-input"
                value={form.points}
                onChange={(e) =>
                  onFormChange({ ...form, points: Number(e.target.value) })
                }
                placeholder="Points"
                required
                min={1}
              />
              <input
                type="text"
                className="form-input"
                list="admin-category-options"
                value={form.category}
                onChange={(e) =>
                  onFormChange({ ...form, category: e.target.value })
                }
                placeholder="Category"
                required
              />
              <datalist id="admin-category-options">
                {categoryOptions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <select
                className="form-input"
                value={form.difficulty}
                onChange={(e) =>
                  onFormChange({ ...form, difficulty: e.target.value })
                }
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="insane">Insane</option>
              </select>
              <input
                type="url"
                className="form-input"
                value={form.link}
                onChange={(e) =>
                  onFormChange({ ...form, link: e.target.value })
                }
                placeholder="Link (optional)"
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "10px",
              }}
            >
              <label
                className="btn"
                style={{
                  fontSize: "12px",
                  padding: "6px 12px",
                  cursor: "pointer",
                  margin: 0,
                }}
              >
                {formFiles.length > 0 ? "Add more files" : "Upload files"}
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    onFormFilesChange([...formFiles, ...picked]);
                    e.target.value = "";
                  }}
                />
              </label>
              {formFiles.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  style={{
                    fontSize: "12px",
                    color: "var(--fg-dim)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {file.name} ({formatSize(file.size)})
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: "11px", padding: "2px 6px" }}
                    onClick={() =>
                      onFormFilesChange(formFiles.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </button>
                </span>
              ))}
              {form.mode === "dynamic" && formFiles.length > 0 && (
                <span style={{ fontSize: "11px", color: "var(--fg-dim)" }}>
                  In the Dockerfile, COPY each file by its exact name.
                </span>
              )}
            </div>
            <div
              style={{
                marginBottom: "10px",
                padding: "10px",
                border: "1px solid var(--border)",
                borderRadius: "4px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "6px",
                }}
              >
                <span style={{ fontSize: "12px", fontWeight: 600 }}>Hints</span>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: "11px", padding: "4px 8px" }}
                  onClick={() =>
                    onFormChange({
                      ...form,
                      hints: [...form.hints, { content: "", cost: 0 }],
                    })
                  }
                >
                  + Add hint
                </button>
              </div>
              {form.hints.length === 0 && (
                <span style={{ fontSize: "12px", color: "var(--fg-dim)" }}>
                  No hints yet.
                </span>
              )}
              {form.hints.map((hint, index) => (
                <div
                  key={index}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 80px auto",
                    gap: "8px",
                    alignItems: "center",
                    marginBottom: "6px",
                  }}
                >
                  <input
                    type="text"
                    className="form-input"
                    value={hint.content}
                    onChange={(e) => {
                      const hints = [...form.hints];
                      hints[index] = { ...hint, content: e.target.value };
                      onFormChange({ ...form, hints });
                    }}
                    placeholder={`Hint ${index + 1} content`}
                  />
                  <input
                    type="number"
                    className="form-input"
                    value={hint.cost}
                    onChange={(e) => {
                      const hints = [...form.hints];
                      hints[index] = { ...hint, cost: Number(e.target.value) };
                      onFormChange({ ...form, hints });
                    }}
                    placeholder="Cost"
                    min={0}
                  />
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: "11px", padding: "4px 8px" }}
                    onClick={() =>
                      onFormChange({
                        ...form,
                        hints: form.hints.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            {buildStatus && (
              <div
                style={{
                  marginBottom: "10px",
                  padding: "10px",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "6px",
                  }}
                >
                  Image build:{" "}
                  <span
                    style={{
                      color:
                        buildStatus.state === "FAILED"
                          ? "var(--danger)"
                          : "var(--fg-muted)",
                    }}
                  >
                    {buildStatus.state}
                  </span>
                </div>
                {buildStatus.log && (
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "180px",
                      overflow: "auto",
                      fontSize: "11px",
                      fontFamily: "var(--font-mono)",
                      color: "var(--fg-dim)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {buildStatus.log.slice(-4000)}
                  </pre>
                )}
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={creating}
            >
              {creating
                ? buildStatus
                  ? `Building image (${buildStatus.state})...`
                  : "Creating..."
                : "Create Challenge"}
            </button>
          </form>
        </div>
      )}

      {/* Challenges table */}
      <table className="table">
        <thead>
          <tr>
            <th {...getThProps("title")}>Title{getSortIndicator("title")}</th>
            <th {...getThProps("category")}>
              Category{getSortIndicator("category")}
            </th>
            <th {...getThProps("points", { textAlign: "right" })}>
              Pts{getSortIndicator("points")}
            </th>
            <th {...getThProps("difficulty")}>
              Diff{getSortIndicator("difficulty")}
            </th>
            <th {...getThProps("solves", { textAlign: "right" })}>
              Solves{getSortIndicator("solves")}
            </th>
            <th {...getThProps("status")}>
              Status{getSortIndicator("status")}
            </th>
            <th>Container</th>
            <th style={{ textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((c) => (
            <Fragment key={c.id}>
              <tr>
                <td style={{ fontWeight: 500 }}>{c.title}</td>
                <td>{c.category}</td>
                <td style={{ textAlign: "right" }}>{c.points}</td>
                <td>{c.difficulty}</td>
                <td style={{ textAlign: "right" }}>{c._count.submissions}</td>
                <td>
                  <span
                    style={{
                      color: c.isActive ? "var(--success)" : "var(--danger)",
                      fontSize: "12px",
                    }}
                  >
                    {c.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td>
                  {c.containerConfig ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(expandedId === c.id ? null : c.id)
                        }
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--fg-muted)",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontFamily: "var(--font-mono)",
                          padding: 0,
                        }}
                        title="Manage files (build context)"
                      >
                        {expandedId === c.id ? "▾" : "▸"}
                      </button>
                      <span
                        title={c.containerConfig.imageDigest ?? undefined}
                        style={{
                          fontSize: "12px",
                          fontFamily: "var(--font-mono)",
                          color:
                            c.containerConfig.buildState === "READY"
                              ? "var(--success)"
                              : c.containerConfig.buildState === "FAILED"
                                ? "var(--danger)"
                                : "var(--fg-muted)",
                        }}
                      >
                        {c.containerConfig.buildState}
                      </span>
                    </span>
                  ) : (
                    <span style={{ fontSize: "12px", color: "var(--fg-dim)" }}>
                      —
                    </span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    onClick={() => onToggleChallenge(c.id, c.isActive)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--fg-muted)",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontFamily: "var(--font-mono)",
                      marginRight: "8px",
                    }}
                  >
                    {c.isActive ? "disable" : "enable"}
                  </button>
                  <button
                    onClick={() => onDeleteChallenge(c.id, c.title)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--danger)",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    delete
                  </button>
                </td>
              </tr>
              {c.containerConfig && expandedId === c.id && (
                <tr>
                  <td
                    colSpan={8}
                    style={{ background: "var(--bg-muted, transparent)" }}
                  >
                    <DockerfilePanel
                      key={c.id}
                      challenge={c}
                      busy={rebuildBusyId === c.id}
                      onRebuild={onRebuild}
                    />
                    <ChallengeFilesPanel
                      challenge={c}
                      uploading={uploadingId === c.id}
                      onUploadFiles={onUploadFiles}
                      onDeleteFile={onDeleteFile}
                    />
                    <TestInstancePanel
                      challenge={c}
                      busy={testBusyId === c.id}
                      onStartTest={onStartTest}
                      onStopTest={onStopTest}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type {
  BranchRecord,
  CommitRecord,
  DirectoryListing,
  DirectoryRoot,
  FileDiff,
  ProjectRecord,
  ProjectStatus,
  ProjectStatusSection
} from "@gitpocket/shared";

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "") ?? "";

type ProjectResponse = { items: ProjectRecord[] };
type DiffResponse = { items: FileDiff[] };
type CommitResponse = { items: CommitRecord[] };
type BranchResponse = { items: BranchRecord[] };
type RootsResponse = { items: DirectoryRoot[] };
type DiffMode = "inline" | "split";

type DiffRow = {
  kind: "context" | "remove" | "add" | "meta";
  leftNumber: number | null;
  rightNumber: number | null;
  leftText: string;
  rightText: string;
};

const sectionOrder: ProjectStatusSection[] = ["conflicted", "staged", "unstaged", "untracked"];
const tabItems = ["status", "diff", "commits", "branches"] as const;

async function safeFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function countBySection(status: ProjectStatus | null, section: ProjectStatusSection) {
  return status?.entries.filter((entry) => entry.section === section).length ?? 0;
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
    </div>
  );
}

function parseHunkHeader(line: string) {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return {
    left: match ? Number(match[1]) : 0,
    right: match ? Number(match[2]) : 0
  };
}

function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  const rows: DiffRow[] = [];
  let leftLine = 0;
  let rightLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      rows.push({
        kind: "meta",
        leftNumber: null,
        rightNumber: null,
        leftText: line,
        rightText: line
      });
      continue;
    }

    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      leftLine = header.left;
      rightLine = header.right;
      rows.push({
        kind: "meta",
        leftNumber: null,
        rightNumber: null,
        leftText: line,
        rightText: line
      });
      continue;
    }

    if (line.startsWith("-")) {
      const next = lines[index + 1] ?? "";
      if (next.startsWith("+")) {
        rows.push({
          kind: "remove",
          leftNumber: leftLine,
          rightNumber: rightLine,
          leftText: line.slice(1),
          rightText: next.slice(1)
        });
        leftLine += 1;
        rightLine += 1;
        index += 1;
        continue;
      }

      rows.push({
        kind: "remove",
        leftNumber: leftLine,
        rightNumber: null,
        leftText: line.slice(1),
        rightText: ""
      });
      leftLine += 1;
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        kind: "add",
        leftNumber: null,
        rightNumber: rightLine,
        leftText: "",
        rightText: line.slice(1)
      });
      rightLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      rows.push({
        kind: "context",
        leftNumber: leftLine,
        rightNumber: rightLine,
        leftText: line.slice(1),
        rightText: line.slice(1)
      });
      leftLine += 1;
      rightLine += 1;
      continue;
    }

    rows.push({
      kind: "context",
      leftNumber: null,
      rightNumber: null,
      leftText: line,
      rightText: line
    });
  }

  return rows;
}

function DiffInline({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse font-mono text-[11px] leading-5">
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.kind}-${index}`}
              className={clsx(
                row.kind === "meta" && "bg-white/5 text-slate-400",
                row.kind === "context" && "bg-transparent text-slate-200",
                row.kind === "add" && "bg-emerald-400/10 text-emerald-100",
                row.kind === "remove" && "bg-rose-400/10 text-rose-100"
              )}
            >
              <td className="w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500">{row.leftNumber ?? ""}</td>
              <td className="w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500">{row.rightNumber ?? ""}</td>
              <td className="px-3 py-1 whitespace-pre">
                {row.kind === "meta" ? row.leftText : `${row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "} ${row.rightText || row.leftText}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffSplit({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse font-mono text-[11px] leading-5">
        <tbody>
          {rows.map((row, index) =>
            row.kind === "meta" ? (
              <tr key={`${row.kind}-${index}`} className="bg-white/5 text-slate-400">
                <td colSpan={4} className="px-3 py-1 whitespace-pre">
                  {row.leftText}
                </td>
              </tr>
            ) : (
              <tr key={`${row.kind}-${index}`}>
                <td
                  className={clsx(
                    "w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500",
                    row.kind === "remove" && "bg-rose-400/10",
                    row.kind === "context" && "bg-transparent"
                  )}
                >
                  {row.leftNumber ?? ""}
                </td>
                <td
                  className={clsx(
                    "w-1/2 border-r border-white/5 px-3 py-1 whitespace-pre",
                    row.kind === "remove" && "bg-rose-400/10 text-rose-100",
                    row.kind === "context" && "text-slate-200"
                  )}
                >
                  {row.leftText}
                </td>
                <td
                  className={clsx(
                    "w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500",
                    row.kind === "add" && "bg-emerald-400/10",
                    row.kind === "context" && "bg-transparent",
                    row.kind === "remove" && row.rightText && "bg-emerald-400/10"
                  )}
                >
                  {row.rightNumber ?? ""}
                </td>
                <td
                  className={clsx(
                    "w-1/2 px-3 py-1 whitespace-pre",
                    row.kind === "add" && "bg-emerald-400/10 text-emerald-100",
                    row.kind === "context" && "text-slate-200",
                    row.kind === "remove" && row.rightText && "bg-emerald-400/10 text-emerald-100"
                  )}
                >
                  {row.rightText}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [commits, setCommits] = useState<CommitRecord[]>([]);
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [tab, setTab] = useState<(typeof tabItems)[number]>("diff");
  const [diffMode, setDiffMode] = useState<DiffMode>("inline");
  const [form, setForm] = useState({ name: "", path: "" });
  const [roots, setRoots] = useState<DirectoryRoot[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingListing, setLoadingListing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function loadProjects() {
      setLoadingProjects(true);
      try {
        const projectData = await safeFetch<ProjectResponse>("/api/projects");
        if (!cancelled) {
          setProjects(projectData.items);
          setActiveProjectId((current) => current ?? projectData.items[0]?.id ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : "Failed to load projects");
        }
      } finally {
        if (!cancelled) {
          setLoadingProjects(false);
        }
      }
    }

    async function loadRootsAndListing() {
      try {
        const rootsData = await safeFetch<RootsResponse>("/api/fs/roots");
        if (!cancelled) {
          setRoots(rootsData.items);
        }
      } catch (error) {
        if (!cancelled) {
          setBootError((current) => current ?? (error instanceof Error ? error.message : "Failed to load server roots"));
        }
      }

      try {
        const directoryData = await safeFetch<DirectoryListing>("/api/fs/list");
        if (!cancelled) {
          setListing(directoryData);
        }
      } catch (error) {
        if (!cancelled) {
          setBootError((current) => current ?? (error instanceof Error ? error.message : "Failed to load directory list"));
        }
      }
    }

    void loadProjects();
    void loadRootsAndListing();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadProjectDetails(projectId: string) {
      setLoadingDetails(true);
      setPanelError(null);

      try {
        const [nextStatus, nextDiffs, nextCommits, nextBranches] = await Promise.all([
          safeFetch<ProjectStatus>(`/api/projects/${projectId}/status`),
          safeFetch<DiffResponse>(`/api/projects/${projectId}/diff`),
          safeFetch<CommitResponse>(`/api/projects/${projectId}/log`),
          safeFetch<BranchResponse>(`/api/projects/${projectId}/branches`)
        ]);

        if (cancelled) {
          return;
        }

        setStatus(nextStatus);
        setDiffs(nextDiffs.items);
        setCommits(nextCommits.items);
        setBranches(nextBranches.items);
      } catch (error) {
        if (!cancelled) {
          setPanelError(error instanceof Error ? error.message : "Failed to load project");
          setStatus(null);
          setDiffs([]);
          setCommits([]);
          setBranches([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingDetails(false);
        }
      }
    }

    if (!activeProjectId) {
      setStatus(null);
      setDiffs([]);
      setCommits([]);
      setBranches([]);
      return;
    }

    void loadProjectDetails(activeProjectId);
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  async function loadDirectory(path?: string) {
    setLoadingListing(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const data = await safeFetch<DirectoryListing>(`/api/fs/list${query}`);
      setListing(data);
      setBootError(null);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "Failed to browse server directories");
    } finally {
      setLoadingListing(false);
    }
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const response = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        throw new Error(`Failed to add project: ${response.status}`);
      }

      const project = (await response.json()) as ProjectRecord;
      setProjects((current) => {
        const next = [project, ...current.filter((item) => item.id !== project.id)];
        return next;
      });
      setActiveProjectId(project.id);
      setForm({ name: "", path: "" });
      setBootError(null);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(125,211,252,0.16),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(190,242,100,0.08),_transparent_22%),linear-gradient(180deg,_#0b1020_0%,_#050816_58%,_#03050d_100%)] text-slate-100">
      <div className="mx-auto min-h-screen max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-signal-cyan">
              Remote Git Workspace
            </div>
            <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">GitPocket</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              Observe remote repos, inspect diffs, and track AI-driven code changes from phone or desktop.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Repos</p>
              <p className="mt-2 text-2xl font-semibold text-white">{projects.length}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Staged</p>
              <p className="mt-2 text-2xl font-semibold text-lime-300">{countBySection(status, "staged")}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Unstaged</p>
              <p className="mt-2 text-2xl font-semibold text-amber-300">{countBySection(status, "unstaged")}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Conflicts</p>
              <p className="mt-2 text-2xl font-semibold text-rose-300">{countBySection(status, "conflicted")}</p>
            </div>
          </div>
        </header>

        {bootError && <div className="mb-6 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{bootError}</div>}

        <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="space-y-6">
            <section className="rounded-3xl border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Project Intake</p>
                  <p className="mt-1 text-sm text-slate-300">Pick a folder directly from the server-side directory list.</p>
                </div>
                <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-200">
                  {roots.length > 0 ? `${roots.length} roots` : "all paths"}
                </div>
              </div>

              <form onSubmit={addProject} className="space-y-3">
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Project name"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none placeholder:text-slate-500"
                />
                <textarea
                  value={form.path}
                  onChange={(event) => setForm((current) => ({ ...current, path: event.target.value }))}
                  placeholder="/data/repos/trading-system"
                  rows={2}
                  className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm text-white outline-none placeholder:text-slate-500"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void loadDirectory(form.path || listing?.currentPath)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-slate-200"
                  >
                    Refresh list
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (form.path && !form.name.trim()) {
                        setForm((current) => ({
                          ...current,
                          name: current.path.split("/").filter(Boolean).at(-1) ?? current.name
                        }));
                      }
                    }}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-slate-200"
                  >
                    Auto name
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={submitting || !form.name.trim() || !form.path.trim()}
                  className="w-full rounded-xl bg-white px-3 py-3 text-sm font-medium text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Adding..." : "Add project"}
                </button>
              </form>

              <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Directory List</p>
                    <p className="mt-1 truncate font-mono text-[11px] text-slate-300">{listing?.currentPath ?? "Loading..."}</p>
                  </div>
                  <div className="flex gap-2">
                    {listing?.parentPath && (
                      <button
                        type="button"
                        onClick={() => void loadDirectory(listing.parentPath!)}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
                      >
                        Up
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void loadDirectory()}
                      className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
                    >
                      Root
                    </button>
                  </div>
                </div>

                {roots.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {roots.map((root) => (
                      <button
                        key={root.path}
                        type="button"
                        onClick={() => void loadDirectory(root.path)}
                        className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-200"
                      >
                        {root.name}
                      </button>
                    ))}
                  </div>
                )}

                {loadingListing && !listing ? (
                  <EmptyPanel title="Loading directories" body="Querying the server filesystem." />
                ) : listing ? (
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    {listing.entries.filter((entry) => entry.type === "directory").map((entry) => (
                      <div key={entry.path} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{entry.name}</p>
                          <p className="mt-1 truncate font-mono text-[11px] text-slate-500">{entry.path}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {entry.isGitRepo && (
                            <button
                              type="button"
                              onClick={() =>
                                setForm((current) => ({
                                  ...current,
                                  path: entry.path,
                                  name: current.name || entry.name
                                }))
                              }
                              className="rounded-full border border-lime-400/30 bg-lime-400/10 px-2.5 py-1 text-[11px] text-lime-200"
                            >
                              Select
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void loadDirectory(entry.path)}
                            className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                          >
                            Open
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="No directory data" body="The server directory list has not loaded yet." />
                )}
              </div>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Projects</p>
                  <p className="mt-1 text-sm text-slate-300">Saved on the server, not just in this browser.</p>
                </div>
                <div className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-slate-300">{projects.length} repos</div>
              </div>

              {loadingProjects ? (
                <EmptyPanel title="Loading projects" body="Reading saved repositories from the server." />
              ) : projects.length === 0 ? (
                <EmptyPanel title="No projects yet" body="Select a Git repository from the directory list and add it." />
              ) : (
                <div className="space-y-3">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => setActiveProjectId(project.id)}
                      className={clsx(
                        "w-full rounded-2xl border p-3 text-left transition",
                        activeProjectId === project.id ? "border-signal-cyan/60 bg-signal-cyan/10" : "border-white/10 bg-black/20"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-base font-medium text-white">{project.name}</p>
                          <p className="mt-1 truncate font-mono text-xs text-slate-400">{project.branch}</p>
                        </div>
                        <div className="shrink-0 rounded-full bg-white/5 px-2 py-1 text-xs text-slate-300">{project.changedFiles} changed</div>
                      </div>
                      <p className="mt-3 truncate font-mono text-[11px] text-slate-500">{project.path}</p>
                      <p className="mt-2 truncate text-xs text-slate-300">{project.lastCommit?.message ?? "No commits yet"}</p>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </aside>

          <main className="min-w-0 rounded-3xl border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur sm:p-5">
            {activeProject ? (
              <>
                <div className="mb-5 flex flex-col gap-4 border-b border-white/10 pb-4 xl:flex-row xl:items-end xl:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Active Repo</p>
                    <h2 className="mt-1 truncate text-2xl font-semibold text-white">{activeProject.name}</h2>
                    <p className="mt-2 truncate font-mono text-xs text-slate-500">{activeProject.path}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Branch</p>
                      <p className="mt-2 truncate font-mono text-sm text-white">{status?.branch ?? activeProject.branch}</p>
                    </div>
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Ahead</p>
                      <p className="mt-2 text-sm text-white">{status?.ahead ?? 0}</p>
                    </div>
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Behind</p>
                      <p className="mt-2 text-sm text-white">{status?.behind ?? 0}</p>
                    </div>
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Files</p>
                      <p className="mt-2 text-sm text-white">{activeProject.changedFiles}</p>
                    </div>
                  </div>
                </div>

                <div className="mb-5 grid grid-cols-4 gap-2 rounded-2xl bg-black/20 p-1">
                  {tabItems.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setTab(item)}
                      className={clsx("rounded-xl px-2 py-3 text-xs font-medium capitalize transition", tab === item ? "bg-white text-slate-900" : "text-slate-400")}
                    >
                      {item}
                    </button>
                  ))}
                </div>

                {panelError && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{panelError}</div>}

                {loadingDetails ? (
                  <EmptyPanel title="Loading repository details" body="Fetching status, diff, commit log, and branch data." />
                ) : tab === "status" ? (
                  status && status.entries.length > 0 ? (
                    <div className="space-y-5">
                      {sectionOrder.map((section) => {
                        const items = status.entries.filter((entry) => entry.section === section);
                        if (items.length === 0) {
                          return null;
                        }
                        return (
                          <section key={section}>
                            <div className="mb-2 flex items-center justify-between">
                              <h3 className="text-sm font-medium capitalize text-white">{section}</h3>
                              <span className="rounded-full bg-black/20 px-2.5 py-1 text-[11px] text-slate-400">{items.length}</span>
                            </div>
                            <div className="space-y-2">
                              {items.map((entry) => (
                                <div key={`${entry.section}-${entry.path}`} className="flex items-center gap-3 rounded-2xl bg-black/20 px-3 py-3">
                                  <span className="w-8 font-mono text-sm text-signal-lime">{entry.code}</span>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm text-white">{entry.path}</p>
                                    <p className="text-xs uppercase tracking-[0.12em] text-slate-500">{entry.section}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyPanel title="Working tree is clean" body="This repository has no staged, unstaged, untracked, or conflicted files." />
                  )
                ) : tab === "diff" ? (
                  <>
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">Diff Viewer</p>
                        <p className="text-xs text-slate-400">Inline on mobile, optional split mode on wide screens.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-black/20 p-1">
                        {(["inline", "split"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setDiffMode(mode)}
                            className={clsx("rounded-xl px-3 py-2 text-xs font-medium capitalize", diffMode === mode ? "bg-white text-slate-900" : "text-slate-400")}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>
                    {diffs.length > 0 ? (
                      <div className="space-y-4">
                        {diffs.map((diff) => {
                          const rows = parsePatch(diff.patch);
                          return (
                            <article key={diff.path} className="overflow-hidden rounded-2xl border border-white/10 bg-black/25">
                              <div className="flex items-center justify-between border-b border-white/10 bg-black/40 px-3 py-3 backdrop-blur">
                                <div className="min-w-0">
                                  <p className="truncate text-sm text-white">{diff.path}</p>
                                  <p className="mt-1 text-xs text-slate-400">
                                    <span className="text-lime-300">+{diff.additions}</span> / <span className="text-rose-300">-{diff.deletions}</span>
                                  </p>
                                </div>
                                {diff.tooLarge && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-1 text-[11px] text-amber-200">large file</span>}
                              </div>
                              {diff.tooLarge ? (
                                <div className="px-3 py-4 font-mono text-[11px] leading-5 text-slate-400">Patch hidden for files larger than 2MB.</div>
                              ) : diffMode === "split" ? (
                                <div className="hidden xl:block">
                                  <DiffSplit rows={rows} />
                                </div>
                              ) : null}
                              {diff.tooLarge ? null : diffMode === "split" ? (
                                <>
                                  <div className="xl:hidden">
                                    <DiffInline rows={rows} />
                                  </div>
                                  <div className="hidden xl:block">
                                    <DiffSplit rows={rows} />
                                  </div>
                                </>
                              ) : (
                                <DiffInline rows={rows} />
                              )}
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyPanel title="No diff output" body="Select a repo with working tree changes to inspect inline or split patches here." />
                    )}
                  </>
                ) : tab === "commits" ? (
                  commits.length > 0 ? (
                    <div className="space-y-2">
                      {commits.map((commit) => (
                        <div key={commit.hash} className="rounded-2xl bg-black/20 px-3 py-3">
                          <p className="text-sm text-white">{commit.message}</p>
                          <p className="mt-1 font-mono text-xs text-slate-400">{commit.hash.slice(0, 7)}</p>
                          <p className="mt-2 text-xs text-slate-500">
                            {commit.author} • {commit.date}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyPanel title="No commits loaded" body="Commit history will appear here once the selected repository is available." />
                  )
                ) : branches.length > 0 ? (
                  <div className="space-y-2">
                    {branches.map((branch) => (
                      <div key={branch.name} className="flex items-center justify-between gap-3 rounded-2xl bg-black/20 px-3 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{branch.name}</p>
                          <p className="mt-1 font-mono text-xs text-slate-500">{branch.commit.slice(0, 7)}</p>
                        </div>
                        {branch.current && <span className="shrink-0 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200">current</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="No branches loaded" body="Branch metadata will appear here for the selected repository." />
                )}
              </>
            ) : (
              <EmptyPanel title="No active repository" body="Pick a saved project from the left column, or add one from the server directory list." />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

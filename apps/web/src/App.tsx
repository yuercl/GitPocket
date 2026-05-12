import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type {
  BranchRecord,
  CommitRecord,
  DirectoryListing,
  DirectoryRoot,
  FileContent,
  FileDiff,
  ProjectRecord,
  ProjectStatus,
  ProjectStatusSection,
  StatusEntry
} from "@gitpocket/shared";

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "") ?? "";

type ProjectResponse = { items: ProjectRecord[] };
type DiffResponse = { items: FileDiff[] };
type CommitResponse = { items: CommitRecord[] };
type BranchResponse = { items: BranchRecord[] };
type RootsResponse = { items: DirectoryRoot[] };
type CommitFilesResponse = { items: FileDiff[] };
type DiffMode = "inline" | "split";
type Viewer =
  | { kind: "content"; path: string; ref: string | null; content: string; tooLarge?: boolean }
  | { kind: "diff"; path: string; patch: string; tooLarge?: boolean };

type DiffRow = {
  kind: "context" | "remove" | "add" | "meta";
  leftNumber: number | null;
  rightNumber: number | null;
  leftText: string;
  rightText: string;
};

type DiffGroup = {
  label: string;
  items: FileDiff[];
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
      rows.push({ kind: "meta", leftNumber: null, rightNumber: null, leftText: line, rightText: line });
      continue;
    }

    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      leftLine = header.left;
      rightLine = header.right;
      rows.push({ kind: "meta", leftNumber: null, rightNumber: null, leftText: line, rightText: line });
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

function countBySection(status: ProjectStatus | null, section: ProjectStatusSection) {
  return status?.entries.filter((entry) => entry.section === section).length ?? 0;
}

function getDiffGroupLabel(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 1 ? "root" : parts.slice(0, -1).join("/");
}

function groupDiffsByDirectory(diffs: FileDiff[]): DiffGroup[] {
  const groups = new Map<string, FileDiff[]>();

  for (const diff of diffs) {
    const label = getDiffGroupLabel(diff.path);
    const items = groups.get(label) ?? [];
    items.push(diff);
    groups.set(label, items);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, items]) => ({
      label,
      items: items.sort((a, b) => a.path.localeCompare(b.path))
    }));
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
      <p className="text-sm font-medium text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
    </div>
  );
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
                row.kind === "context" && "text-slate-200",
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
                <td className={clsx("w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500", row.kind === "remove" && "bg-rose-400/10")}>
                  {row.leftNumber ?? ""}
                </td>
                <td className={clsx("w-1/2 border-r border-white/5 px-3 py-1 whitespace-pre", row.kind === "remove" && "bg-rose-400/10 text-rose-100", row.kind === "context" && "text-slate-200")}>
                  {row.leftText}
                </td>
                <td className={clsx("w-12 border-r border-white/5 px-2 py-1 text-right text-slate-500", (row.kind === "add" || (row.kind === "remove" && row.rightText)) && "bg-emerald-400/10")}>
                  {row.rightNumber ?? ""}
                </td>
                <td className={clsx("w-1/2 px-3 py-1 whitespace-pre", row.kind === "add" && "bg-emerald-400/10 text-emerald-100", row.kind === "context" && "text-slate-200", row.kind === "remove" && row.rightText && "bg-emerald-400/10 text-emerald-100")}>
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

function DiffFileList({
  diffs,
  selectedPath,
  onSelect,
  heightClass = "max-h-[32vh]",
  dense = false,
  grouped = false
}: {
  diffs: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  heightClass?: string;
  dense?: boolean;
  grouped?: boolean;
}) {
  const groups = grouped ? groupDiffsByDirectory(diffs) : null;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-2">
      <div className="mb-2 flex items-center justify-between px-2 py-1">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Changed Files</p>
          <p className="mt-1 text-[11px] text-slate-400">{diffs.length} files with patch output</p>
        </div>
      </div>
      <div className={clsx(heightClass, "space-y-2 overflow-y-auto pr-1")}>
        {groups
          ? groups.map((group) => (
              <section key={group.label} className="space-y-2">
                <div className="px-2 pt-2">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{group.label}</p>
                </div>
                {group.items.map((diff) => (
                  <button
                    key={diff.path}
                    type="button"
                    onClick={() => onSelect(diff.path)}
                    className={clsx(
                      "w-full rounded-xl border text-left transition",
                      dense ? "px-3 py-2.5" : "px-3 py-3",
                      diff.path === selectedPath ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-white/5"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-sm text-white">{diff.path.split("/").at(-1) ?? diff.path}</p>
                      <p className="shrink-0 text-[11px] text-slate-400">
                        <span className="text-lime-300">+{diff.additions}</span>
                        {" "}
                        <span className="text-rose-300">-{diff.deletions}</span>
                      </p>
                    </div>
                  </button>
                ))}
              </section>
            ))
          : diffs.map((diff) => (
              <button
                key={diff.path}
                type="button"
                onClick={() => onSelect(diff.path)}
                className={clsx(
                  "w-full rounded-xl border text-left transition",
                  dense ? "px-3 py-2.5" : "px-3 py-3",
                  diff.path === selectedPath ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-white/5"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm text-white">{diff.path}</p>
                  <p className="shrink-0 text-[11px] text-slate-400">
                    <span className="text-lime-300">+{diff.additions}</span>
                    {" "}
                    <span className="text-rose-300">-{diff.deletions}</span>
                  </p>
                </div>
              </button>
            ))}
      </div>
    </div>
  );
}

function DiffCanvas({
  diff,
  diffMode,
  onBack,
  onPrevious,
  onNext,
  className
}: {
  diff: FileDiff;
  diffMode: DiffMode;
  onBack?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  className?: string;
}) {
  return (
    <article className={clsx("overflow-hidden rounded-2xl border border-white/10 bg-black/25", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/40 px-3 py-3 backdrop-blur">
        <div className="min-w-0">
          <p className="truncate text-sm text-white">{diff.path}</p>
          <p className="mt-1 text-xs text-slate-400">
            <span className="text-lime-300">+{diff.additions}</span> / <span className="text-rose-300">-{diff.deletions}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onPrevious && (
            <button type="button" onClick={onPrevious} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">
              Prev
            </button>
          )}
          {onNext && (
            <button type="button" onClick={onNext} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">
              Next
            </button>
          )}
          {diff.tooLarge && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-1 text-[11px] text-amber-200">large file</span>}
          {onBack && (
            <button type="button" onClick={onBack} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">
              Back
            </button>
          )}
        </div>
      </div>
      <div className="max-h-full overflow-auto">
        {diff.tooLarge ? (
          <div className="px-3 py-4 font-mono text-[11px] leading-5 text-slate-400">Patch hidden for files larger than 2MB.</div>
        ) : diffMode === "split" ? (
          <>
            <div className="xl:hidden">
              <DiffInline rows={parsePatch(diff.patch)} />
            </div>
            <div className="hidden xl:block">
              <DiffSplit rows={parsePatch(diff.patch)} />
            </div>
          </>
        ) : (
          <DiffInline rows={parsePatch(diff.patch)} />
        )}
      </div>
    </article>
  );
}

function ViewerPanel({ viewer, diffMode }: { viewer: Viewer; diffMode: DiffMode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="mb-3">
        <p className="text-sm font-medium text-white">{viewer.path}</p>
        <p className="mt-1 text-xs text-slate-400">{viewer.kind === "diff" ? "diff preview" : viewer.ref ? `ref: ${viewer.ref}` : "working tree"}</p>
      </div>
      {viewer.kind === "diff" ? (
        viewer.tooLarge ? (
          <div className="font-mono text-[11px] leading-5 text-slate-400">Patch hidden for files larger than 2MB.</div>
        ) : diffMode === "split" ? (
          <>
            <div className="xl:hidden">
              <DiffInline rows={parsePatch(viewer.patch)} />
            </div>
            <div className="hidden xl:block">
              <DiffSplit rows={parsePatch(viewer.patch)} />
            </div>
          </>
        ) : (
          <DiffInline rows={parsePatch(viewer.patch)} />
        )
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-slate-200">
          {viewer.tooLarge ? "File too large to preview." : viewer.content}
        </pre>
      )}
    </section>
  );
}

function FullscreenViewer({ viewer, diffMode, onClose }: { viewer: Viewer; diffMode: DiffMode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-[#03050d]">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-white">{viewer.path}</p>
            <p className="mt-1 text-xs text-slate-400">{viewer.kind === "diff" ? "diff preview" : viewer.ref ? `ref: ${viewer.ref}` : "working tree"}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ViewerPanel viewer={viewer} diffMode={diffMode} />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitRecord[]>([]);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileDiff[]>([]);
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [tab, setTab] = useState<(typeof tabItems)[number]>("diff");
  const [previousTab, setPreviousTab] = useState<(typeof tabItems)[number] | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("inline");
  const [form, setForm] = useState({ name: "", path: "" });
  const [roots, setRoots] = useState<DirectoryRoot[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [compactLandscape, setCompactLandscape] = useState(false);
  const [compactPortrait, setCompactPortrait] = useState(false);
  const [mobileDiffOpen, setMobileDiffOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingListing, setLoadingListing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const selectedDiff = diffs.find((diff) => diff.path === selectedDiffPath) ?? diffs[0] ?? null;
  const selectedCommit = commits.find((commit) => commit.hash === selectedCommitHash) ?? commits[0] ?? null;

  useEffect(() => {
    const landscapeQuery = window.matchMedia("(max-width: 1023px) and (orientation: landscape)");
    const portraitQuery = window.matchMedia("(max-width: 1023px) and (orientation: portrait)");

    const update = () => {
      setCompactLandscape(landscapeQuery.matches);
      setCompactPortrait(portraitQuery.matches);
    };

    update();
    landscapeQuery.addEventListener("change", update);
    portraitQuery.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      landscapeQuery.removeEventListener("change", update);
      portraitQuery.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

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
        setSelectedDiffPath((current) =>
          current && nextDiffs.items.some((item) => item.path === current) ? current : (nextDiffs.items[0]?.path ?? null)
        );
        setCommits(nextCommits.items);
        setSelectedCommitHash((current) => (current && nextCommits.items.some((item) => item.hash === current) ? current : nextCommits.items[0]?.hash ?? null));
        setBranches(nextBranches.items);
        setViewer(null);
        setCommitFiles([]);
        setSelectedCommitFilePath(null);
        setMobileDiffOpen(false);
        setPanelError(null);
      } catch (error) {
        if (!cancelled) {
          setPanelError(error instanceof Error ? error.message : "Failed to load project");
          setStatus(null);
          setDiffs([]);
          setSelectedDiffPath(null);
          setCommits([]);
          setSelectedCommitHash(null);
          setCommitFiles([]);
          setSelectedCommitFilePath(null);
          setBranches([]);
          setViewer(null);
          setMobileDiffOpen(false);
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
      setSelectedDiffPath(null);
      setCommits([]);
      setSelectedCommitHash(null);
      setCommitFiles([]);
      setSelectedCommitFilePath(null);
      setBranches([]);
      setViewer(null);
      setMobileDiffOpen(false);
      return;
    }

    void loadProjectDetails(activeProjectId);
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    setPanelError(null);
  }, [tab]);

  useEffect(() => {
    let cancelled = false;

    async function loadFiles() {
      if (!activeProjectId || !selectedCommitHash) {
        setCommitFiles([]);
        return;
      }

      try {
        const data = await safeFetch<CommitFilesResponse>(
          `/api/projects/${activeProjectId}/commit-files?commit=${encodeURIComponent(selectedCommitHash)}`
        );
        if (!cancelled) {
          setCommitFiles(data.items);
          setSelectedCommitFilePath((current) =>
            current && data.items.some((item) => item.path === current) ? current : (data.items[0]?.path ?? null)
          );
        }
      } catch (error) {
        if (!cancelled) {
          setCommitFiles([]);
          setSelectedCommitFilePath(null);
          setPanelError(error instanceof Error ? error.message : "Failed to load commit files");
        }
      }
    }

    void loadFiles();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, selectedCommitHash]);

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

  async function loadFileContent(path: string, ref?: string | null) {
    if (!activeProjectId) {
      return;
    }

    const query = new URLSearchParams({ path });
    if (ref) {
      query.set("ref", ref);
    }

    const data = await safeFetch<FileContent>(`/api/projects/${activeProjectId}/file?${query.toString()}`);
    setViewer({
      kind: "content",
      path: data.path,
      ref: data.ref,
      content: data.content,
      tooLarge: data.tooLarge
    });
  }

  function openWorkingDiff(path: string) {
    const diff = diffs.find((item) => item.path === path);
    if (!diff) {
      return;
    }
    setPreviousTab(tab);
    setSelectedDiffPath(path);
    setTab("diff");
    setMobileDiffOpen(true);
  }

  function openCommitDiff(file: FileDiff) {
    setViewer({
      kind: "diff",
      path: file.path,
      patch: file.patch,
      tooLarge: file.tooLarge
    });
  }

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const normalizedName = form.name.trim() || form.path.split("/").filter(Boolean).at(-1) || "repo";
      const response = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: normalizedName, path: form.path })
      });
      if (!response.ok) {
        throw new Error(`Failed to add project: ${response.status}`);
      }
      const project = (await response.json()) as ProjectRecord;
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setActiveProjectId(project.id);
      setForm({ name: "", path: "" });
      setBootError(null);
      setWorkspaceMenuOpen(false);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }

  const mobile = !window.matchMedia("(min-width: 1024px)").matches;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(125,211,252,0.16),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(190,242,100,0.08),_transparent_22%),linear-gradient(180deg,_#0b1020_0%,_#050816_58%,_#03050d_100%)] text-slate-100">
      <div className={clsx("mx-auto min-h-screen py-4 sm:py-6", compactLandscape ? "max-w-none px-2" : "max-w-[1800px] px-4 sm:px-6 lg:px-8")}>
        <header className={clsx("mb-4 flex items-end justify-between gap-4", mobile && "sticky top-0 z-20 rounded-3xl border border-white/10 bg-black/35 px-3 py-3 backdrop-blur")}>
          <div className="min-w-0">
            <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-signal-cyan">
              Remote Git Workspace
            </div>
            <h1 className={clsx("mt-3 font-display font-semibold tracking-tight text-white", mobile ? "text-2xl" : "text-3xl xl:text-4xl")}>GitPocket</h1>
            {!mobile && <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">Observe remote repos, inspect diffs, and track AI-driven code changes from phone or desktop.</p>}
          </div>
          <button type="button" onClick={() => setWorkspaceMenuOpen(true)} className={clsx("border border-cyan-400/20 bg-cyan-400/10 text-left", mobile ? "rounded-2xl px-4 py-3" : "rounded-xl px-3 py-2")}>
            <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-200">Workspace</p>
            <p className={clsx("font-medium text-white", mobile ? "mt-2 text-sm" : "mt-1 text-xs")}>Projects</p>
          </button>
        </header>

        {!mobile && (
          <div className="mb-4 grid grid-cols-4 gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Repos</p>
              <p className="mt-2 text-xl font-semibold text-white">{projects.length}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Staged</p>
              <p className="mt-2 text-xl font-semibold text-lime-300">{countBySection(status, "staged")}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Unstaged</p>
              <p className="mt-2 text-xl font-semibold text-amber-300">{countBySection(status, "unstaged")}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Conflicts</p>
              <p className="mt-2 text-xl font-semibold text-rose-300">{countBySection(status, "conflicted")}</p>
            </div>
          </div>
        )}

        {bootError && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{bootError}</div>}

        {workspaceMenuOpen && (
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setWorkspaceMenuOpen(false)}>
            <aside
              className={clsx("absolute right-0 top-0 h-full overflow-auto border-l border-white/10 bg-ink-950/95 shadow-panel", compactLandscape ? "w-[46vw] min-w-[340px] p-3" : "w-full max-w-md p-4")}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Workspace</p>
                  <p className="mt-1 text-sm text-slate-300">Projects and repo intake</p>
                </div>
                <button type="button" onClick={() => setWorkspaceMenuOpen(false)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">
                  Close
                </button>
              </div>

              <section className="rounded-3xl border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Project Intake</p>
                    <p className="mt-1 text-sm text-slate-300">Browse the server, select a Git repo, then save it.</p>
                  </div>
                  <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-200">{roots.length > 0 ? `${roots.length} roots` : "all paths"}</div>
                </div>

                <form onSubmit={addProject} className="space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Selected Repo</p>
                    {form.path ? (
                      <>
                        <p className="mt-2 text-sm text-white">{form.name || form.path.split("/").filter(Boolean).at(-1) || "Unnamed repo"}</p>
                        <p className="mt-1 truncate font-mono text-[11px] text-slate-400">{form.path}</p>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-slate-400">No repository selected yet. Pick one from the directory list below.</p>
                    )}
                  </div>
                  <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Optional custom project name" className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none placeholder:text-slate-500" />
                  <button type="button" onClick={() => void loadDirectory(listing?.currentPath)} className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-slate-200">
                    Refresh list
                  </button>
                  <button type="submit" disabled={submitting || !form.path.trim()} className="w-full rounded-xl bg-white px-3 py-3 text-sm font-medium text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-50">
                    {submitting ? "Adding..." : "Save selected repo"}
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
                        <button type="button" onClick={() => void loadDirectory(listing.parentPath ?? undefined)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300">
                          Up
                        </button>
                      )}
                      <button type="button" onClick={() => void loadDirectory()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300">
                        Root
                      </button>
                    </div>
                  </div>

                  {roots.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {roots.map((root) => (
                        <button key={root.path} type="button" onClick={() => void loadDirectory(root.path)} className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-200">
                          {root.name}
                        </button>
                      ))}
                    </div>
                  )}

                  {loadingListing && !listing ? (
                    <EmptyPanel title="Loading directories" body="Querying the server filesystem." />
                  ) : listing ? (
                    <div className="max-h-80 space-y-2 overflow-y-auto">
                      {listing.entries
                        .filter((entry) => entry.type === "directory")
                        .map((entry) => (
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
                              <button type="button" onClick={() => void loadDirectory(entry.path)} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300">
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

              <section className="mt-4 rounded-3xl border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur">
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
                  <EmptyPanel title="No projects yet" body="Select a Git repository from the directory list, then save it." />
                ) : (
                  <div className="space-y-3">
                    {projects.map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => {
                          setActiveProjectId(project.id);
                          setWorkspaceMenuOpen(false);
                        }}
                        className={clsx("w-full rounded-2xl border p-3 text-left transition", activeProjectId === project.id ? "border-signal-cyan/60 bg-signal-cyan/10" : "border-white/10 bg-black/20")}
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
          </div>
        )}

        {mobile ? (
          <MobileWorkspace
            activeProject={activeProject}
            status={status}
            diffs={diffs}
            selectedDiff={selectedDiff}
            setSelectedDiffPath={setSelectedDiffPath}
            commits={commits}
            selectedCommit={selectedCommit}
            selectedCommitHash={selectedCommitHash}
            commitFiles={commitFiles}
            selectedCommitFilePath={selectedCommitFilePath}
            setSelectedCommitFilePath={setSelectedCommitFilePath}
            setSelectedCommitHash={setSelectedCommitHash}
            setViewer={setViewer}
            viewer={viewer}
            branches={branches}
            compactPortrait={compactPortrait}
            compactLandscape={compactLandscape}
            mobileDiffOpen={mobileDiffOpen}
            setMobileDiffOpen={setMobileDiffOpen}
            tab={tab}
            setTab={setTab}
            previousTab={previousTab}
            setPreviousTab={setPreviousTab}
            diffMode={diffMode}
            setDiffMode={setDiffMode}
            panelError={panelError}
            loadingDetails={loadingDetails}
            sections={sectionOrder}
            openWorkingDiff={openWorkingDiff}
            loadFileContent={loadFileContent}
            openCommitDiff={openCommitDiff}
          />
        ) : (
          <DesktopWorkspace
            activeProject={activeProject}
            status={status}
            diffs={diffs}
            selectedDiff={selectedDiff}
            setSelectedDiffPath={setSelectedDiffPath}
            commits={commits}
            selectedCommit={selectedCommit}
            selectedCommitHash={selectedCommitHash}
            setSelectedCommitHash={setSelectedCommitHash}
            commitFiles={commitFiles}
            selectedCommitFilePath={selectedCommitFilePath}
            setSelectedCommitFilePath={setSelectedCommitFilePath}
            branches={branches}
            compactPortrait={false}
            compactLandscape={false}
            mobileDiffOpen={mobileDiffOpen}
            setMobileDiffOpen={setMobileDiffOpen}
            tab={tab}
            setTab={setTab}
            previousTab={previousTab}
            setPreviousTab={setPreviousTab}
            diffMode={diffMode}
            setDiffMode={setDiffMode}
            panelError={panelError}
            loadingDetails={loadingDetails}
            sections={sectionOrder}
            viewer={viewer}
            setViewer={setViewer}
            openWorkingDiff={openWorkingDiff}
            loadFileContent={loadFileContent}
            openCommitDiff={openCommitDiff}
          />
        )}
      </div>
      {viewer && compactPortrait && <FullscreenViewer viewer={viewer} diffMode={diffMode} onClose={() => setViewer(null)} />}
    </div>
  );
}

function MobileWorkspace({
  activeProject,
  status,
  diffs,
  selectedDiff,
  setSelectedDiffPath,
  commits,
  selectedCommit,
  selectedCommitHash,
  commitFiles,
  selectedCommitFilePath,
  setSelectedCommitFilePath,
  setSelectedCommitHash,
  setViewer,
  viewer,
  branches,
  compactPortrait,
  compactLandscape,
  mobileDiffOpen,
  setMobileDiffOpen,
  tab,
  setTab,
  previousTab,
  setPreviousTab,
  diffMode,
  setDiffMode,
  panelError,
  loadingDetails,
  sections,
  openWorkingDiff,
  loadFileContent,
  openCommitDiff
}: {
  activeProject: ProjectRecord | null;
  status: ProjectStatus | null;
  diffs: FileDiff[];
  selectedDiff: FileDiff | null;
  setSelectedDiffPath: (path: string) => void;
  commits: CommitRecord[];
  selectedCommit: CommitRecord | null;
  selectedCommitHash: string | null;
  commitFiles: FileDiff[];
  selectedCommitFilePath: string | null;
  setSelectedCommitFilePath: (path: string | null) => void;
  setSelectedCommitHash: (hash: string) => void;
  setViewer: (viewer: Viewer | null) => void;
  viewer: Viewer | null;
  branches: BranchRecord[];
  compactPortrait: boolean;
  compactLandscape: boolean;
  mobileDiffOpen: boolean;
  setMobileDiffOpen: (value: boolean) => void;
  tab: (typeof tabItems)[number];
  setTab: (tab: (typeof tabItems)[number]) => void;
  previousTab: (typeof tabItems)[number] | null;
  setPreviousTab: (tab: (typeof tabItems)[number] | null) => void;
  diffMode: DiffMode;
  setDiffMode: (mode: DiffMode) => void;
  panelError: string | null;
  loadingDetails: boolean;
  sections: ProjectStatusSection[];
  openWorkingDiff: (path: string) => void;
  loadFileContent: (path: string, ref?: string | null) => Promise<void>;
  openCommitDiff: (file: FileDiff) => void;
}) {
  const selectedDiffIndex = selectedDiff ? diffs.findIndex((diff) => diff.path === selectedDiff.path) : -1;

  function selectDiffAt(index: number) {
    const nextDiff = diffs[index];
    if (!nextDiff) {
      return;
    }
    setSelectedDiffPath(nextDiff.path);
    setMobileDiffOpen(true);
  }

  if (!activeProject) {
    return <EmptyPanel title="No active repository" body="Pick a saved project from the workspace menu." />;
  }

  return (
    <main className="rounded-3xl border border-white/10 bg-white/5 p-3 shadow-panel backdrop-blur">
      <div className="mb-3 overflow-x-auto rounded-2xl bg-black/20 p-1">
        <div className="grid min-w-max grid-cols-4 gap-2">
          {tabItems.map((item) => (
            <button key={item} type="button" onClick={() => setTab(item)} className={clsx("rounded-xl px-3 py-3 text-xs font-medium capitalize transition", tab === item ? "bg-white text-slate-900" : "text-slate-400")}>
              {item}
            </button>
          ))}
        </div>
      </div>

      {panelError && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{panelError}</div>}
      {loadingDetails ? (
        <EmptyPanel title="Loading repository details" body="Fetching status, diff, commit log, and branch data." />
      ) : tab === "status" ? (
        <div className={clsx("space-y-4", compactLandscape && "grid grid-cols-[42%_58%] gap-4 space-y-0")}>
          <div className="space-y-4">
          {status?.entries.length ? (
            sections.map((section) => {
              const items = status.entries.filter((entry) => entry.section === section);
              if (!items.length) {
                return null;
              }
              return (
                <section key={section}>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium capitalize text-white">{section}</h3>
                    <span className="rounded-full bg-black/20 px-2.5 py-1 text-[11px] text-slate-400">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((entry: StatusEntry) => {
                      const diff = diffs.find((item) => item.path === entry.path);
                      return (
                        <div key={`${entry.section}-${entry.path}`} className="rounded-2xl bg-black/20 px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-3">
                                <span className="w-8 font-mono text-sm text-signal-lime">{entry.code}</span>
                                <p className="truncate text-sm text-white">{entry.path}</p>
                              </div>
                              <p className="mt-1 text-xs uppercase tracking-[0.12em] text-slate-500">{entry.section}</p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              {diff && (
                                <button
                                  type="button"
                                  onClick={() => openWorkingDiff(entry.path)}
                                  className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                                >
                                  Diff
                                </button>
                              )}
                              <button type="button" onClick={() => void loadFileContent(entry.path)} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300">
                                Content
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          ) : (
            <EmptyPanel title="Working tree is clean" body="This repository has no staged, unstaged, untracked, or conflicted files." />
          )}
          </div>
          {viewer && !compactPortrait && viewer.kind === "content" && <ViewerPanel viewer={viewer} diffMode={diffMode} />}
          {viewer && compactPortrait && viewer.kind === "content" && <FullscreenViewer viewer={viewer} diffMode={diffMode} onClose={() => setViewer(null)} />}
        </div>
      ) : tab === "diff" ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">Diff Viewer</p>
              <p className="text-xs text-slate-400">Single file first on mobile, wider canvas in landscape.</p>
            </div>
            <div className="flex items-center gap-2">
              {previousTab && previousTab !== "diff" && (
                <button
                  type="button"
                  onClick={() => {
                    setTab(previousTab);
                    setPreviousTab(null);
                    setMobileDiffOpen(false);
                  }}
                  className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200"
                >
                  Back to {previousTab}
                </button>
              )}
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-black/20 p-1">
                {(["inline", "split"] as const).map((mode) => (
                  <button key={mode} type="button" onClick={() => setDiffMode(mode)} className={clsx("rounded-xl px-3 py-2 text-xs font-medium capitalize", diffMode === mode ? "bg-white text-slate-900" : "text-slate-400")}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {selectedDiff ? (
            <>
              <div className={clsx("gap-3", compactLandscape ? "grid grid-cols-[36%_64%]" : "block")}>
                {!compactLandscape && (
                  <div className={clsx(mobileDiffOpen && "hidden")}>
                    <DiffFileList
                      diffs={diffs}
                      selectedPath={selectedDiff.path}
                      onSelect={(path) => {
                        setSelectedDiffPath(path);
                        setMobileDiffOpen(true);
                      }}
                    />
                  </div>
                )}
                {compactLandscape && (
                  <DiffFileList diffs={diffs} selectedPath={selectedDiff.path} onSelect={setSelectedDiffPath} heightClass="max-h-[55vh]" dense />
                )}

                <DiffCanvas
                  diff={selectedDiff}
                  diffMode={diffMode}
                  onBack={compactPortrait ? () => setMobileDiffOpen(false) : undefined}
                  onPrevious={selectedDiffIndex > 0 ? () => selectDiffAt(selectedDiffIndex - 1) : undefined}
                  onNext={selectedDiffIndex >= 0 && selectedDiffIndex < diffs.length - 1 ? () => selectDiffAt(selectedDiffIndex + 1) : undefined}
                  className={clsx(compactPortrait && !mobileDiffOpen && "hidden", compactLandscape && "min-h-[60vh]")}
                />
              </div>
            </>
          ) : (
            <EmptyPanel title="No diff output" body="Select a repo with working tree changes to inspect file-by-file patches here." />
          )}
          {viewer && viewer.kind === "content" && <FullscreenViewer viewer={viewer} diffMode={diffMode} onClose={() => setViewer(null)} />}
        </div>
      ) : tab === "commits" ? (
        <div className={clsx("space-y-4", compactLandscape && "grid grid-cols-[40%_60%] gap-4 space-y-0")}>
          <div className="space-y-2">
            {commits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                onClick={() => {
                  setSelectedCommitHash(commit.hash);
                  setViewer(null);
                }}
                className={clsx("w-full rounded-2xl border px-3 py-3 text-left transition", selectedCommitHash === commit.hash ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-black/20")}
              >
                <p className="text-sm text-white">{commit.message}</p>
                <p className="mt-1 font-mono text-xs text-slate-400">{commit.hash.slice(0, 7)}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {commit.author} • {commit.date}
                </p>
              </button>
            ))}
          </div>

          <div className="space-y-4">
          {selectedCommit && (
            <section className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="mb-3">
                <p className="text-sm font-medium text-white">Changed Files</p>
                <p className="mt-1 text-xs text-slate-400">{selectedCommit.hash.slice(0, 7)}</p>
              </div>
              {commitFiles.length > 0 ? (
                <div className="space-y-2">
                  {commitFiles.map((file) => (
                    <div
                      key={file.path}
                      className={clsx(
                        "rounded-xl border px-3 py-3",
                        selectedCommitFilePath === file.path
                          ? "border-cyan-400/40 bg-cyan-400/10"
                          : "border-white/10 bg-white/5"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-white">{file.path}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            <span className="text-lime-300">+{file.additions}</span> / <span className="text-rose-300">-{file.deletions}</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCommitFilePath(file.path);
                              openCommitDiff(file);
                            }}
                            className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                          >
                            Diff
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCommitFilePath(file.path);
                              void loadFileContent(file.path, selectedCommit.hash);
                            }}
                            className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                          >
                            Content
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyPanel title="No files" body="This commit has no changed files available to preview." />
              )}
            </section>
          )}

          {viewer && !compactPortrait && <ViewerPanel viewer={viewer} diffMode={diffMode} />}
          {viewer && compactPortrait && <FullscreenViewer viewer={viewer} diffMode={diffMode} onClose={() => setViewer(null)} />}
          </div>
        </div>
      ) : branches.length > 0 ? (
        <div className={clsx("space-y-2", compactLandscape && "grid grid-cols-2 gap-2 space-y-0")}>
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
    </main>
  );
}

function DesktopWorkspace(props: Parameters<typeof MobileWorkspace>[0]) {
  const {
    activeProject,
    status,
    diffs,
    selectedDiff,
    setSelectedDiffPath,
    commits,
    selectedCommit,
    selectedCommitHash,
    commitFiles,
    selectedCommitFilePath,
    setSelectedCommitFilePath,
    setSelectedCommitHash,
    setViewer,
    viewer,
    branches,
    tab,
    setTab,
    diffMode,
    setDiffMode,
    panelError,
    loadingDetails,
    sections,
    openWorkingDiff,
    loadFileContent,
    openCommitDiff
  } = props;

  if (!activeProject) {
    return <EmptyPanel title="No active repository" body="Pick a saved project from the workspace menu." />;
  }

  return (
    <main className="rounded-[28px] border border-white/10 bg-white/5 p-4 shadow-panel backdrop-blur">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="overflow-x-auto rounded-2xl bg-black/20 p-1">
          <div className="grid min-w-max grid-cols-4 gap-2">
            {tabItems.map((item) => (
              <button key={item} type="button" onClick={() => setTab(item)} className={clsx("rounded-xl px-4 py-3 text-sm font-medium capitalize transition", tab === item ? "bg-white text-slate-900" : "text-slate-400")}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-right">
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Active Repo</p>
          <p className="mt-1 text-sm text-white">{activeProject.name}</p>
          <p className="mt-1 font-mono text-[11px] text-slate-400">{activeProject.branch}</p>
        </div>
      </div>

      {panelError && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{panelError}</div>}

      {loadingDetails ? (
        <EmptyPanel title="Loading repository details" body="Fetching status, diff, commit log, and branch data." />
      ) : tab === "status" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <div className="space-y-4">
            {status?.entries.length ? (
              sections.map((section) => {
                const items = status.entries.filter((entry) => entry.section === section);
                if (!items.length) {
                  return null;
                }
                return (
                  <section key={section} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-medium capitalize text-white">{section}</h3>
                      <span className="rounded-full bg-black/20 px-2.5 py-1 text-[11px] text-slate-400">{items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((entry: StatusEntry) => {
                        const diff = diffs.find((item) => item.path === entry.path);
                        return (
                          <div key={`${entry.section}-${entry.path}`} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-3">
                                  <span className="w-8 font-mono text-sm text-signal-lime">{entry.code}</span>
                                  <p className="truncate text-sm text-white">{entry.path}</p>
                                </div>
                                <p className="mt-1 text-xs uppercase tracking-[0.12em] text-slate-500">{entry.section}</p>
                              </div>
                              <div className="flex shrink-0 gap-2">
                                {diff && (
                                  <button type="button" onClick={() => openWorkingDiff(entry.path)} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300">
                                    Diff
                                  </button>
                                )}
                                <button type="button" onClick={() => void loadFileContent(entry.path)} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300">
                                  Content
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            ) : (
              <EmptyPanel title="Working tree is clean" body="This repository has no staged, unstaged, untracked, or conflicted files." />
            )}
          </div>
          {viewer && <ViewerPanel viewer={viewer} diffMode={diffMode} />}
        </div>
      ) : tab === "diff" ? (
        selectedDiff ? (
          <section className="rounded-[24px] border border-white/10 bg-black/20 p-3">
            <div className="mb-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-white">Diff Explorer</p>
                <p className="mt-1 text-xs text-slate-400">Pinned file list on the left, wider diff canvas on the right.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-black/20 p-1">
                {(["inline", "split"] as const).map((mode) => (
                  <button key={mode} type="button" onClick={() => setDiffMode(mode)} className={clsx("rounded-xl px-4 py-2 text-xs font-medium capitalize", diffMode === mode ? "bg-white text-slate-900" : "text-slate-400")}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
              <DiffFileList diffs={diffs} selectedPath={selectedDiff.path} onSelect={setSelectedDiffPath} heightClass="max-h-[calc(100vh-20rem)]" dense grouped />
              <DiffCanvas diff={selectedDiff} diffMode={diffMode} className="min-h-[70vh]" />
            </div>
          </section>
        ) : (
          <EmptyPanel title="No diff output" body="Select a repo with working tree changes to inspect file-by-file patches here." />
        )
      ) : tab === "commits" ? (
        <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="space-y-2">
            {commits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                onClick={() => {
                  setSelectedCommitHash(commit.hash);
                  setViewer(null);
                }}
                className={clsx("w-full rounded-2xl border px-3 py-3 text-left transition", selectedCommitHash === commit.hash ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-black/20")}
              >
                <p className="text-sm text-white">{commit.message}</p>
                <p className="mt-1 font-mono text-xs text-slate-400">{commit.hash.slice(0, 7)}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {commit.author} • {commit.date}
                </p>
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {selectedCommit && (
              <section className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="mb-3">
                  <p className="text-sm font-medium text-white">Changed Files</p>
                  <p className="mt-1 text-xs text-slate-400">{selectedCommit.hash.slice(0, 7)}</p>
                </div>
                {commitFiles.length > 0 ? (
                  <div className="grid gap-2 2xl:grid-cols-2">
                    {commitFiles.map((file) => (
                      <div
                        key={file.path}
                        className={clsx(
                          "rounded-xl border px-3 py-3",
                          selectedCommitFilePath === file.path ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-white/5"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-white">{file.path}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              <span className="text-lime-300">+{file.additions}</span> / <span className="text-rose-300">-{file.deletions}</span>
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedCommitFilePath(file.path);
                                openCommitDiff(file);
                              }}
                              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                            >
                              Diff
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedCommitFilePath(file.path);
                                void loadFileContent(file.path, selectedCommit.hash);
                              }}
                              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300"
                            >
                              Content
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="No files" body="This commit has no changed files available to preview." />
                )}
              </section>
            )}
            {viewer && <ViewerPanel viewer={viewer} diffMode={diffMode} />}
          </div>
        </div>
      ) : branches.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {branches.map((branch) => (
            <div key={branch.name} className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
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
    </main>
  );
}

import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import type {
  BranchRecord,
  DirectoryListing,
  CommitRecord,
  FileContent,
  FileDiff,
  ProjectRecord,
  ProjectStatus,
  RepoFileEntry,
  StatusEntry
} from "@gitpocket/shared";

const LARGE_FILE_PATCH_LIMIT = 2 * 1024 * 1024;
const LARGE_FILE_CONTENT_LIMIT = 512 * 1024;
const execFile = promisify(execFileCallback);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"]);
const EMPTY_FILE_PATH = "/dev/null";

export type RepoAccessPolicy = {
  allowedRoots: string[];
};

function getDefaultRoot(policy: RepoAccessPolicy) {
  if (policy.allowedRoots.length > 0) {
    return path.resolve(policy.allowedRoots[0]);
  }
  return path.parse(process.cwd()).root;
}

function createGit(repoPath: string) {
  return simpleGit({
    baseDir: repoPath,
    binary: "git",
    maxConcurrentProcesses: 4
  });
}

async function hasCommits(git: ReturnType<typeof createGit>) {
  try {
    await git.revparse(["--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranchName(git: ReturnType<typeof createGit>) {
  try {
    const status = await git.status();
    return status.current ?? "detached";
  } catch {
    return "detached";
  }
}

async function runGitText(repoPath: string, args: string[]) {
  try {
    const { stdout } = await execFile("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: LARGE_FILE_PATCH_LIMIT * 8
    });
    return stdout;
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    if (String(execError.code) === "1") {
      const stdout = execError.stdout;
      return typeof stdout === "string" ? stdout : stdout?.toString("utf8") ?? "";
    }
    throw error;
  }
}

function summarizePatch(patch: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

async function getInitialProjectDiff(repoPath: string) {
  const git = createGit(repoPath);
  const files = await git.raw(["ls-files", "--cached", "--others", "--exclude-standard"]);
  const paths = files
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    paths.map(async (filePath) => {
      const patch = await runGitText(repoPath, ["diff", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "--", EMPTY_FILE_PATH, filePath]);
      const bytes = Buffer.byteLength(patch, "utf8");
      const { additions, deletions } = summarizePatch(patch);
      return {
        path: filePath,
        additions,
        deletions,
        patch: bytes > LARGE_FILE_PATCH_LIMIT ? "" : patch,
        tooLarge: bytes > LARGE_FILE_PATCH_LIMIT
      };
    })
  );
}

function getMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".avif":
      return "image/avif";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".jsx":
      return "text/jsx";
    case ".yml":
    case ".yaml":
      return "text/yaml";
    case ".sh":
      return "text/x-shellscript";
    default:
      return null;
  }
}

function isImagePath(filePath: string) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function looksBinary(buffer: Buffer) {
  if (buffer.length === 0) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function toRepoFileEntry(filePath: string): RepoFileEntry {
  const extension = path.extname(filePath).toLowerCase();
  return {
    path: filePath,
    name: path.basename(filePath),
    extension,
    isImage: isImagePath(filePath)
  };
}

async function readGitObject(repoPath: string, spec: string) {
  const { stdout } = await execFile("git", ["show", spec], {
    cwd: repoPath,
    encoding: "buffer",
    maxBuffer: LARGE_FILE_CONTENT_LIMIT * 8
  });
  return stdout;
}

function ensureInsideAllowedRoots(repoPath: string, policy: RepoAccessPolicy) {
  const resolved = path.resolve(repoPath);
  if (policy.allowedRoots.length === 0) {
    return resolved;
  }

  const allowed = policy.allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
  });

  if (!allowed) {
    throw new Error(`Path ${resolved} is outside ALLOWED_REPO_ROOTS`);
  }

  return resolved;
}

async function isGitRepositoryPath(targetPath: string) {
  try {
    await fs.stat(path.join(targetPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

function getParentPath(targetPath: string, policy: RepoAccessPolicy) {
  const resolved = path.resolve(targetPath);
  if (policy.allowedRoots.length === 0) {
    const parent = path.dirname(resolved);
    return parent === resolved ? null : parent;
  }

  for (const root of policy.allowedRoots.map((item) => path.resolve(item))) {
    if (resolved === root) {
      return null;
    }
    if (resolved.startsWith(`${root}${path.sep}`)) {
      return path.dirname(resolved);
    }
  }
  return null;
}

export async function validateRepo(repoPath: string, policy: RepoAccessPolicy) {
  const resolved = ensureInsideAllowedRoots(repoPath, policy);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path ${resolved} is not a directory`);
  }

  const git = createGit(resolved);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Path ${resolved} is not a git repository`);
  }

  return resolved;
}

export async function listDirectory(targetPath: string, policy: RepoAccessPolicy): Promise<DirectoryListing> {
  const resolved = ensureInsideAllowedRoots(targetPath || getDefaultRoot(policy), policy);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path ${resolved} is not a directory`);
  }

  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((entry) => entry.name !== ".git")
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const entryPath = path.join(resolved, entry.name);
        const directory = entry.isDirectory();
        return {
          name: entry.name,
          path: entryPath,
          type: directory ? ("directory" as const) : ("file" as const),
          isGitRepo: directory ? await isGitRepositoryPath(entryPath) : false
        };
      })
  );

  return {
    currentPath: resolved,
    parentPath: getParentPath(resolved, policy),
    roots:
      policy.allowedRoots.length > 0
        ? policy.allowedRoots.map((root) => ({
            name: path.basename(root) || root,
            path: path.resolve(root)
          }))
        : [
            {
              name: "root",
              path: getDefaultRoot(policy)
            }
          ],
    entries
  };
}

function mapStatusEntries(status: Awaited<ReturnType<ReturnType<typeof createGit>["status"]>>): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const file of status.files) {
    const indexCode = file.index.trim();
    const workingCode = file.working_dir.trim();

    if (file.index === "?" && file.working_dir === "?") {
      entries.push({
        path: file.path,
        code: "??",
        section: "untracked"
      });
      continue;
    }

    if (file.index === "U" || file.working_dir === "U" || status.conflicted.includes(file.path)) {
      entries.push({
        path: file.path,
        code: `${indexCode || " "}${workingCode || " "}`.replaceAll(" ", "") || "UU",
        section: "conflicted"
      });
      continue;
    }

    if (file.index !== " " && file.index !== "?") {
      entries.push({
        path: file.path,
        code: file.index,
        section: "staged"
      });
    }

    if (file.working_dir !== " " && file.working_dir !== "?") {
      entries.push({
        path: file.path,
        code: file.working_dir,
        section: "unstaged"
      });
    }
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.section}:${entry.code}:${entry.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function getProjectRecord(
  id: string,
  name: string,
  repoPath: string,
  policy: RepoAccessPolicy
): Promise<ProjectRecord> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  const [status, commitsAvailable] = await Promise.all([git.status(), hasCommits(git)]);
  const log = commitsAvailable ? await git.log({ maxCount: 1 }) : null;
  const latest = log?.latest ?? null;

  return {
    id,
    name,
    path: resolved,
    branch: status.current ?? "detached",
    changedFiles: status.files.length,
    lastCommit: latest
      ? {
          hash: latest.hash,
          message: latest.message,
          author: latest.author_name,
          time: latest.date
        }
      : null
  };
}

export async function getProjectStatus(repoPath: string, policy: RepoAccessPolicy): Promise<ProjectStatus> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  const status = await git.status();
  return {
    branch: status.current ?? "detached",
    ahead: status.ahead,
    behind: status.behind,
    entries: mapStatusEntries(status)
  };
}

export async function getProjectDiff(repoPath: string, policy: RepoAccessPolicy): Promise<FileDiff[]> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  if (!(await hasCommits(git))) {
    return getInitialProjectDiff(resolved);
  }
  const summary = await git.diffSummary(["HEAD"]);

  return Promise.all(
    summary.files.map(async (file) => {
      const patch = await git.diff(["HEAD", "--", file.file]);
      const bytes = Buffer.byteLength(patch, "utf8");
      return {
        path: file.file,
        additions: "insertions" in file ? file.insertions : 0,
        deletions: "deletions" in file ? file.deletions : 0,
        patch: bytes > LARGE_FILE_PATCH_LIMIT ? "" : patch,
        tooLarge: bytes > LARGE_FILE_PATCH_LIMIT
      };
    })
  );
}

export async function getProjectLog(repoPath: string, policy: RepoAccessPolicy): Promise<CommitRecord[]> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  if (!(await hasCommits(git))) {
    return [];
  }
  const log = await git.log({ maxCount: 20 });
  return log.all.map((commit) => ({
    hash: commit.hash,
    author: commit.author_name,
    date: commit.date,
    message: commit.message
  }));
}

export async function getProjectBranches(repoPath: string, policy: RepoAccessPolicy): Promise<BranchRecord[]> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  if (!(await hasCommits(git))) {
    return [
      {
        name: await getCurrentBranchName(git),
        current: true,
        commit: ""
      }
    ];
  }
  const branches = await git.branch(["-vv"]);
  return Object.values(branches.branches).map((branch) => ({
    name: branch.name,
    current: branch.current,
    commit: branch.commit
  }));
}

export async function getRepoFiles(repoPath: string, policy: RepoAccessPolicy, ref?: string): Promise<RepoFileEntry[]> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  const raw = ref
    ? await git.raw(["ls-tree", "-r", "--name-only", ref])
    : await git.raw(["ls-files", "--cached", "--others", "--exclude-standard"]);

  return raw
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map(toRepoFileEntry);
}

export async function getFileContent(
  repoPath: string,
  filePath: string,
  policy: RepoAccessPolicy,
  ref?: string
): Promise<FileContent> {
  const resolved = await validateRepo(repoPath, policy);
  const buffer = ref ? await readGitObject(resolved, `${ref}:${filePath}`) : await fs.readFile(path.join(resolved, filePath));
  const tooLarge = buffer.byteLength > LARGE_FILE_CONTENT_LIMIT;
  const mimeType = getMimeType(filePath);
  const image = isImagePath(filePath);

  if (image) {
    return {
      path: filePath,
      ref: ref ?? null,
      kind: "image",
      mimeType,
      encoding: "base64",
      content: tooLarge ? "" : buffer.toString("base64"),
      tooLarge
    };
  }

  if (looksBinary(buffer)) {
    return {
      path: filePath,
      ref: ref ?? null,
      kind: "binary",
      mimeType,
      encoding: "base64",
      content: "",
      tooLarge
    };
  }

  return {
    path: filePath,
    ref: ref ?? null,
    kind: "text",
    mimeType,
    encoding: "utf8",
    content: tooLarge ? "" : buffer.toString("utf8"),
    tooLarge
  };
}

export async function getCommitFiles(
  repoPath: string,
  commitHash: string,
  policy: RepoAccessPolicy
): Promise<FileDiff[]> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);
  const summary = await git.diffSummary([`${commitHash}^!`]);

  return Promise.all(
    summary.files.map(async (file) => {
      const patch = await git.raw(["show", "--format=", commitHash, "--", file.file]);
      const bytes = Buffer.byteLength(patch, "utf8");
      return {
        path: file.file,
        additions: "insertions" in file ? file.insertions : 0,
        deletions: "deletions" in file ? file.deletions : 0,
        patch: bytes > LARGE_FILE_PATCH_LIMIT ? "" : patch,
        tooLarge: bytes > LARGE_FILE_PATCH_LIMIT
      };
    })
  );
}

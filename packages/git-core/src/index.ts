import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type {
  BranchRecord,
  DirectoryListing,
  CommitRecord,
  FileContent,
  FileDiff,
  ProjectRecord,
  ProjectStatus,
  StatusEntry
} from "@gitpocket/shared";

const LARGE_FILE_PATCH_LIMIT = 2 * 1024 * 1024;
const LARGE_FILE_CONTENT_LIMIT = 512 * 1024;

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
  const [status, log] = await Promise.all([git.status(), git.log({ maxCount: 1 })]);
  const latest = log.latest;

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
  const branches = await git.branch(["-vv"]);
  return Object.values(branches.branches).map((branch) => ({
    name: branch.name,
    current: branch.current,
    commit: branch.commit
  }));
}

export async function getFileContent(
  repoPath: string,
  filePath: string,
  policy: RepoAccessPolicy,
  ref?: string
): Promise<FileContent> {
  const resolved = await validateRepo(repoPath, policy);
  const git = createGit(resolved);

  if (ref) {
    const content = await git.show([`${ref}:${filePath}`]);
    const tooLarge = Buffer.byteLength(content, "utf8") > LARGE_FILE_CONTENT_LIMIT;
    return {
      path: filePath,
      ref,
      content: tooLarge ? "" : content,
      tooLarge
    };
  }

  const absolutePath = path.join(resolved, filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const tooLarge = Buffer.byteLength(content, "utf8") > LARGE_FILE_CONTENT_LIMIT;
  return {
    path: filePath,
    ref: null,
    content: tooLarge ? "" : content,
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

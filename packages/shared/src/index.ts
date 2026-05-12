export type ProjectId = string;

export type ProjectRecord = {
  id: ProjectId;
  name: string;
  path: string;
  branch: string;
  changedFiles: number;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    time: string;
  } | null;
};

export type ProjectStatusSection = "staged" | "unstaged" | "untracked" | "conflicted";

export type StatusEntry = {
  path: string;
  code: string;
  section: ProjectStatusSection;
};

export type ProjectStatus = {
  branch: string;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
};

export type FileDiff = {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  tooLarge?: boolean;
};

export type CommitRecord = {
  hash: string;
  author: string;
  date: string;
  message: string;
};

export type BranchRecord = {
  name: string;
  current: boolean;
  commit: string;
};

export type AddProjectInput = {
  name: string;
  path: string;
};

export type DirectoryRoot = {
  name: string;
  path: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  isGitRepo: boolean;
};

export type DirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  roots: DirectoryRoot[];
  entries: DirectoryEntry[];
};

export type RepoSnapshot = {
  project: ProjectRecord;
  status: ProjectStatus;
  diffs: FileDiff[];
  commits: CommitRecord[];
  branches: BranchRecord[];
};

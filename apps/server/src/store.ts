import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddProjectInput, ProjectRecord } from "@gitpocket/shared";
import { getProjectRecord, type RepoAccessPolicy } from "@gitpocket/git-core";

type StoredProject = {
  id: string;
  name: string;
  path: string;
};

type PersistedProjects = {
  projects: StoredProject[];
};

export class ProjectStore {
  private readonly projects = new Map<string, StoredProject>();

  constructor(
    private readonly policy: RepoAccessPolicy,
    private readonly storageFile: string
  ) {}

  async init() {
    await fs.mkdir(path.dirname(this.storageFile), { recursive: true });

    try {
      const raw = await fs.readFile(this.storageFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedProjects;
      for (const project of parsed.projects ?? []) {
        this.projects.set(project.id, project);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      throw error;
    }
  }

  private async persist() {
    const payload: PersistedProjects = {
      projects: Array.from(this.projects.values())
    };
    await fs.writeFile(this.storageFile, JSON.stringify(payload, null, 2), "utf8");
  }

  async addProject(input: AddProjectInput): Promise<ProjectRecord> {
    const existing = Array.from(this.projects.values()).find((project) => project.path === input.path);
    const project = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      path: input.path
    };

    const hydrated = await getProjectRecord(project.id, project.name, project.path, this.policy);
    this.projects.set(project.id, project);
    await this.persist();
    return hydrated;
  }

  async getProjects(): Promise<ProjectRecord[]> {
    const rows = Array.from(this.projects.values());
    const hydrated = await Promise.all(
      rows.map(async (row) => {
        try {
          return await getProjectRecord(row.id, row.name, row.path, this.policy);
        } catch {
          return {
            id: row.id,
            name: row.name,
            path: row.path,
            branch: "unavailable",
            changedFiles: 0,
            lastCommit: null
          } satisfies ProjectRecord;
        }
      })
    );

    return hydrated;
  }

  getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async removeProject(id: string) {
    const existed = this.projects.delete(id);
    if (!existed) {
      return false;
    }
    await this.persist();
    return true;
  }
}

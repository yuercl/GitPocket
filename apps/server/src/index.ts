import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  getProjectBranches,
  getProjectDiff,
  getProjectLog,
  getProjectStatus,
  listDirectory,
  type RepoAccessPolicy
} from "@gitpocket/git-core";
import { ProjectStore } from "./store.js";

const port = Number(process.env.PORT ?? 8788);
const allowedRoots = (process.env.ALLOWED_REPO_ROOTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const projectsFile = process.env.PROJECTS_FILE ?? path.resolve(".data/projects.json");

const policy: RepoAccessPolicy = { allowedRoots };
const projectStore = new ProjectStore(policy, projectsFile);
await projectStore.init();

const addProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1)
});

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

app.get("/health", async () => ({
  ok: true,
  allowedRoots,
  projectsFile
}));

app.get("/api/fs/roots", async () => ({
  items: allowedRoots.map((root) => ({
    name: root.split("/").filter(Boolean).at(-1) ?? root,
    path: root
  }))
}));

app.get("/api/fs/list", async (request, reply) => {
  const pathQuery = (request.query as { path?: string }).path ?? allowedRoots[0];
  try {
    return await listDirectory(pathQuery, policy);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to list directory"
    });
  }
});

app.get("/api/projects", async () => ({
  items: await projectStore.getProjects()
}));

app.post("/api/projects", async (request, reply) => {
  const parsed = addProjectSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid project payload",
      issues: parsed.error.flatten()
    });
  }

  try {
    const project = await projectStore.addProject(parsed.data);
    return reply.code(201).send(project);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Failed to add project"
    });
  }
});

app.get("/api/projects/:id/status", async (request, reply) => {
  const project = projectStore.getProject((request.params as { id: string }).id);
  if (!project) {
    return reply.code(404).send({ error: "Project not found" });
  }
  return getProjectStatus(project.path, policy);
});

app.get("/api/projects/:id/diff", async (request, reply) => {
  const project = projectStore.getProject((request.params as { id: string }).id);
  if (!project) {
    return reply.code(404).send({ error: "Project not found" });
  }
  return {
    items: await getProjectDiff(project.path, policy)
  };
});

app.get("/api/projects/:id/log", async (request, reply) => {
  const project = projectStore.getProject((request.params as { id: string }).id);
  if (!project) {
    return reply.code(404).send({ error: "Project not found" });
  }
  return {
    items: await getProjectLog(project.path, policy)
  };
});

app.get("/api/projects/:id/branches", async (request, reply) => {
  const project = projectStore.getProject((request.params as { id: string }).id);
  if (!project) {
    return reply.code(404).send({ error: "Project not found" });
  }
  return {
    items: await getProjectBranches(project.path, policy)
  };
});

try {
  await app.listen({
    port,
    host: "0.0.0.0"
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

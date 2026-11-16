import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = resolve(
  process.cwd(),
  process.env.PROJECTS_CONFIG_PATH || "projects.config.json",
);

/**
 * Loads the projects configuration file. Fails fast if missing or malformed.
 */
export const loadProjectsConfig = () => {
  if (!existsSync(configPath)) {
    throw new Error(
      `[Config] [FATAL] Configuration file not found at '${configPath}'. Check PROJECTS_CONFIG_PATH in .env.`,
    );
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[Config] [FATAL] Failed to parse '${configPath}': ${err.message}`,
    );
  }
};

/**
 * Resolves deployment target configuration from projects.config.json (Single Source of Truth).
 */
export const resolveBranchConfig = (repository, branch) => {
  const projects = loadProjectsConfig();

  // 1. Guard: Repository must be explicitly registered
  if (!projects[repository]) {
    return {
      shouldDeploy: false,
      reason: `Repository '${repository}' is not registered in projects.config.json`,
    };
  }

  // 2. Guard: Branch must be explicitly configured
  const project = projects[repository];
  const branchConfig = project.branches?.[branch];

  if (!branchConfig) {
    return {
      shouldDeploy: false,
      reason: `Branch '${branch}' is not configured for repository '${repository}' in projects.config.json`,
    };
  }

  // 3. Strict Validation: Mandatory deployment fields
  if (!branchConfig.targetDir) {
    throw new Error(
      `[Config] [FATAL] 'targetDir' is missing for '${repository}:${branch}' in projects.config.json`,
    );
  }

  if (!branchConfig.port) {
    throw new Error(
      `[Config] [FATAL] 'port' is missing for '${repository}:${branch}' in projects.config.json`,
    );
  }

  return {
    shouldDeploy: true,
    env: branchConfig.env || "production",
    port: Number(branchConfig.port),
    targetDir: branchConfig.targetDir,
    configPath: branchConfig.configPath || "ecosystem.config.js",
    healthEndpoint: branchConfig.healthEndpoint || "/health",
    envSource: branchConfig.envSource || null,
  };
};

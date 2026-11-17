import { Worker } from "bullmq";
import { redisClient } from "../configs/redis.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setCommitStatus } from "../services/githubStatus.js";
import { sendDeploymentNotification } from "../services/notifier.js";
import { publishDeploymentLog } from "../services/logStreamer.js";

const bashBin =
  process.platform === "win32" &&
  existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";

const workerClient = redisClient.duplicate();
await workerClient.connect();

//workers
export const deployWorker = new Worker(
  "cicd-server-queue",
  async (job) => {
    const {
      repository,
      branch,
      commitSha,
      commitMessage,
      commitUrl,
      author,
      depsChanged,
      isPrivate = false,
      deployEnv = "production",
      targetPort,
      targetDir,
      configPath,
      healthEndpoint,
      envSource,
    } = job.data;
    const lkgKey = `lkg:${repository}:${branch}`;
    const currentLkg = (await redisClient.get(lkgKey)) || "";
    const startTime = Date.now();

    console.log(
      `[Worker] Processing Job #${job.id}: Deploying ${repository} (${branch}) - ${commitSha}`,
    );
    console.log(
      `[Worker] Current LKG for ${repository}:${branch}: ${
        currentLkg ? currentLkg.slice(0, 7) : "(none / Day 0)"
      }`,
    );

    // Stream initial status logs to Redis
    await publishDeploymentLog(
      job.id,
      `[Worker] Processing Job #${job.id}: Deploying ${repository} (${branch}) - ${commitSha.slice(0, 7)}`,
      "status",
    );
    await publishDeploymentLog(
      job.id,
      currentLkg
        ? `[Worker] Current LKG on record: ${currentLkg.slice(0, 7)}`
        : "[Worker] Day 0 detected: No prior verified LKG on record",
      "status",
    );

    await setCommitStatus({
      repo: repository,
      commitSha,
      context: "Deployment",
      description: "Deployment in progress..",
      state: "pending",
    });

    return new Promise((resolve, reject) => {
      const deployScriptPath =
        process.env.DEPLOY_SCRIPT_PATH || "./scripts/deploy.sh";
      if (!existsSync(deployScriptPath)) {
        return reject(
          new Error(
            `[Worker] [FATAL] Deploy script not found at '${deployScriptPath}'. Check DEPLOY_SCRIPT_PATH in .env.`,
          ),
        );
      }

      // Do NOT leak CI/CD server's PORT (4566) into child deploy process
      const { PORT: _ciPort, ...cleanEnv } = process.env;

      const childProcess = spawn(bashBin, [deployScriptPath], {
        env: {
          ...cleanEnv,
          PORT: targetPort ? String(targetPort) : "4000",
          BRANCH: branch,
          REPOSITORY: repository,
          COMMIT_SHA: commitSha,
          DEPS_CHANGED: String(depsChanged),
          LKG_COMMIT: currentLkg,
          IS_PRIVATE: String(isPrivate),
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
          TARGET_DIR: targetDir || "",
          TARGET_PORT: targetPort ? String(targetPort) : "",
          CONFIG_PATH: configPath || "",
          HEALTH_ENDPOINT: healthEndpoint || "",
          DEPLOY_ENV: deployEnv,
          ENV_SOURCE: envSource || "",
        },
      });

      childProcess.on("spawn", () => {
        console.log("child process spawned");
      });

      childProcess.stdout.on("data", async (data) => {
        process.stdout.write(data);
        childProcess.stdout.pause();
        try {
          await publishDeploymentLog(job.id, data.toString(), "log");
        } finally {
          childProcess.stdout.resume();
        }
      });

      childProcess.stderr.on("data", async (data) => {
        process.stderr.write(data);
        childProcess.stderr.pause();
        try {
          await publishDeploymentLog(job.id, data.toString(), "log");
        } finally {
          childProcess.stderr.resume();
        }
      });

      childProcess.on("close", async (code) => {
        const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

        if (code == 0) {
          console.log(`[Worker] Job #${job.id} completed successfully.`);
          await redisClient.set(lkgKey, commitSha);
          console.log(
            `[Worker] Updated LKG in Redis for ${repository}:${branch} -> ${commitSha.slice(0, 7)}`,
          );

          await publishDeploymentLog(
            job.id,
            {
              status: "success",
              code: 0,
              duration,
              commitSha,
              message: "Deployment passed all health checks!",
            },
            "complete",
          );

          await setCommitStatus({
            repo: repository,
            commitSha,
            state: "success",
            description: "Deployment passed all health checks!",
          });

          await sendDeploymentNotification({
            repository,
            branch,
            commitSha,
            commitMessage,
            commitUrl,
            author,
            status: "success",
            duration,
            depsChanged,
            lkgSha: commitSha,
            isDayZero: !currentLkg,
            deployEnv,
          });

          return resolve({ success: true, commitSha });
        } else {
          console.error(`[Worker] Job #${job.id} failed with code ${code}.`);
          const isDayZero = !currentLkg;
          const failureDesc = currentLkg
            ? `Deployment failed. Rolled back to LKG: ${currentLkg.slice(0, 7)}`
            : "Initial deployment (Day 0) failed. Service torn down.";

          await publishDeploymentLog(
            job.id,
            {
              status: "failure",
              code,
              duration,
              commitSha,
              message: failureDesc,
            },
            "complete",
          );

          await setCommitStatus({
            repo: repository,
            commitSha,
            state: "failure",
            description: failureDesc,
          });

          await sendDeploymentNotification({
            repository,
            branch,
            commitSha,
            commitMessage,
            commitUrl,
            author,
            status: "failure",
            duration,
            depsChanged,
            lkgSha: currentLkg,
            isDayZero,
            deployEnv,
            errorMessage: `deploy.sh exited with code ${code}`,
          });

          return reject(new Error(`Job failed with code ${code}`));
        }
      });

      childProcess.on("error", async (err) => {
        const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        console.error(
          `[Worker] Job #${job.id} encountered an error during execution.`,
        );

        await publishDeploymentLog(
          job.id,
          {
            status: "failure",
            error: err.message,
            message: "Internal execution error occurred.",
          },
          "complete",
        );
        await setCommitStatus({
          repo: repository,
          commitSha,
          state: "failure",
          description: "Internal execution error occurred.",
        });

        await sendDeploymentNotification({
          repository,
          branch,
          commitSha,
          commitMessage,
          commitUrl,
          author,
          status: "failure",
          duration,
          depsChanged,
          lkgSha: currentLkg,
          isDayZero: !currentLkg,
          deployEnv,
          errorMessage: err.message,
        });

        return reject(err);
      });
    });
  },
  { connection: workerClient, concurrency: 1 },
);

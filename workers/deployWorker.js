import { Worker } from "bullmq";
import { redisClient } from "../configs/redis.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setCommitStatus } from "../services/githubStatus.js";

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
    const { repository, branch, commitSha, author, depsChanged } = job.data;
    console.log(
      `[Worker] Processing Job #${job.id}: Deploying ${repository} (${branch}) - ${commitSha}`,
    );

    await setCommitStatus({
      repo: repository,
      commitSha,
      context: "Deployment",
      description: "Deployment in progress..",
      state: "pending",
    });

    return new Promise((resolve, reject) => {
      const path = process.env.DEPLOY_SCRIPT_PATH || "./deploy.sh";
      if (!path) return reject(new Error("script path not found."));
      const childProcess = spawn(bashBin, [path, branch, String(depsChanged)], {
        env: { ...process.env },
      });

      childProcess.on("spawn", () => {
        console.log("child process spawned");
      });

      childProcess.stdout.on("data", (data) => {
        process.stdout.write(data);
      });

      childProcess.stderr.on("data", (data) => {
        process.stdout.write(data);
      });

      childProcess.on("close", async (code) => {
        if (code == 0) {
          console.log(`[Worker] Job #${job.id} completed successfully.`);
          await setCommitStatus({
            repo: repository,
            commitSha,
            state: "success",
            description: "Deployment passed all health checks!",
          });
          return resolve({ success: true, commitSha });
        } else {
          console.error(`[Worker] Job #${job.id} failed with code ${code}.`);
          await setCommitStatus({
            repo: repository,
            commitSha,
            state: "failure",
            description: "Deployment failed. Auto-rollback triggered.",
          });
          return reject(new Error(`Job failed with code ${code}`));
        }
      });

      childProcess.on("error", async (err) => {
        console.error(
          `[Worker] Job #${job.id} encountered an error during execution.`,
        );
        await setCommitStatus({
          repo: repository,
          commitSha,
          state: "failure",
          description: "Internal execution error occurred.",
        });
        return reject(err);
      });
    });
  },
  { connection: workerClient, concurrency: 1 },
);

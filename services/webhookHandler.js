import crypto from "node:crypto";
import { deployQueue } from "../queues/deployQueue.js";
import { resolveBranchConfig } from "./projectConfig.js";
/**
 * Constant-time HMAC-SHA256 signature verification
 */
export const verifyWebhookSignature = (rawBody, signature, secret) => {
  if (!signature || !secret || !rawBody) return false;

  const computedSignature = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  // Length guard to prevent crypto.timingSafeEqual RangeError
  if (signature.length !== computedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(computedSignature),
  );
};

/**
 * Evaluates whether this GitHub event should trigger a deployment
 */
export const filterWebhookEvent = (event, body) => {
  if (event === "ping") {
    return { shouldDeploy: false, statusCode: 200, response: { msg: "pong" } };
  }
  if (event !== "push") {
    return {
      shouldDeploy: false,
      statusCode: 200,
      response: { msg: `Ignored ${event} event` },
    };
  }
  if (body?.deleted) {
    return {
      shouldDeploy: false,
      statusCode: 200,
      response: { msg: "Branch deletion ignored" },
    };
  }

  return { shouldDeploy: true };
};

/**
 * Pure parser that extracts commit metadata and analyzes file delta
 */
export const parseWebhookPayload = (body) => {
  const branch = body.ref ? body.ref.replace("refs/heads/", "") : "main";
  const commits = body.commits || [];

  // Flatten all modified, added, and removed file paths
  const changedFiles = commits.flatMap((c) => [
    ...(c.added || []),
    ...(c.modified || []),
    ...(c.removed || []),
  ]);

  // Fast Deploy check: true if lockfiles were modified
  const depsChanged = changedFiles.some(
    (file) => file.endsWith("package.json") || file.endsWith("package-lock.json"),
  );

  const headCommit = body.head_commit || commits[commits.length - 1] || {};
  const commitMessage = headCommit.message || "No commit message provided";
  const commitUrl =
    headCommit.url ||
    `https://github.com/${body.repository?.full_name}/commit/${body.after}`;

  const repository = body.repository?.full_name || "unknown";
  const branchConfig = resolveBranchConfig(repository, branch);

  return {
    shouldDeploy: branchConfig.shouldDeploy,
    reason: branchConfig.reason,
    repository,
    branch,
    commitSha: body.after,
    commitMessage,
    commitUrl,
    author: body.pusher?.name || headCommit.author?.name || "unknown",
    depsChanged,
    isPrivate: Boolean(body.repository?.private),
    deployEnv: branchConfig.env,
    targetPort: branchConfig.port,
    targetDir: branchConfig.targetDir,
    configPath: branchConfig.configPath,
    healthEndpoint: branchConfig.healthEndpoint,
  };
};

/**
 * The Combined Controller Handler
 */
export const handleGithubWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-hub-signature-256"];
    const isAuthentic = verifyWebhookSignature(
      req.rawBody,
      signature,
      process.env.WEBHOOK_SECRET,
    );

    if (!isAuthentic) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.headers["x-github-event"];
    const filter = filterWebhookEvent(event, req.body);
    if (!filter.shouldDeploy) {
      return res.status(filter.statusCode).json(filter.response);
    }

    const jobData = parseWebhookPayload(req.body);
    if (!jobData.shouldDeploy) {
      console.log(`[Webhook] Skipping deployment: ${jobData.reason}`);
      return res.status(200).json({ msg: jobData.reason });
    }

    const job = await deployQueue.add("github-deploy", jobData);

    console.log(
      `[Queue] Added deployment job #${job.id} for commit ${jobData.commitSha?.slice(0, 7)} [${jobData.deployEnv}] (depsChanged: ${jobData.depsChanged})`,
    );

    return res.status(202).json({
      msg: "Deployment queued successfully",
      jobId: job.id,
    });
  } catch (err) {
    console.error("[Webhook Error] Job queueing failed:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};


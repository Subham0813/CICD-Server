import express from "express";
import crypto from "node:crypto";
import { deployQueue } from "./queues/deployQueue.js";
import "./workers/deployWorker.js";

const app = express();
const port = process.env.TARGET_PORT || 5050;

app.use(
  express.json({
    verify: (req, _, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (_, res) => {
  res.json({ msg: "Server is healthy." });
});

app.post("/api/github/webhook", async (req, res) => {
  try {
    const body = req.body;
    //chcek signature
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) {
      return res.status(401).json({ error: "Missing signature header" });
    }
    const computedSignature = `sha256=${crypto
      .createHmac("sha256", process.env.WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex")}`;

    // Guard length before comparing to prevent RangeError crash
    if (signature.length !== computedSignature.length) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSignature),
    );

    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.headers["x-github-event"];
    if (event === "ping") return res.status(200).json({ msg: "pong" });
    if (event !== "push")
      return res.status(200).json({ msg: `Ignored ${event} event` });
    if (body.deleted)
      return res.status(200).json({ msg: "Branch deletion ignored" });

    const branch = body.ref ? body.ref.replace("refs/heads/", "") : "main";

    //detect changed files
    const commits = body.commits || [];
    const changedFiles = commits.flatMap((c) => [
      ...(c.added || []),
      ...(c.modified || []),
      ...(c.removed || []),
    ]);

    //detect dependcies changes
    const depsChanged = changedFiles.some(
      (f) => f.endsWith("package.json") || f.endsWith("package-lock.json"),
    );

    const job = await deployQueue.add("github-deploy", {
      repository: body.repository?.full_name || "unknown",
      branch,
      commitSha: body.after,
      author: body.pusher?.name || "unknown",
      depsChanged, // boolean: true if dependencies need reinstalling
    });

    console.log(
      `[Queue] Added deployment job #${job.id} for commit ${body.after?.slice(0, 7)} (depsChanged: ${depsChanged})`,
    );

    // Return 202 Accepted with the job ID
    return res.status(202).json({
      msg: "Deployment queued successfully",
      jobId: job.id,
    });
  } catch (err) {
    console.error("Job adding failed:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log("server listening on port: ", port);
});

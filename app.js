import express from "express";
import crypto from "node:crypto";
import { deployQueue } from "./queues/deployQueue.js";
import "./workers/deployWorker.js";
import { handleDeploymentLogStream } from "./services/logStreamer.js";
import { handleGithubWebhook } from "./services/webhookHandler.js";

const app = express();
const port = process.env.PORT || 5050;

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

app.post("/api/github/webhook", handleGithubWebhook);

// SSE Live Log Streaming Endpoint
app.get("/api/deployments/:jobId/logs", handleDeploymentLogStream);

app.listen(port, () => {
  console.log("server listening on port: ", port);
});

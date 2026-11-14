import { redisClient } from "../configs/redis.js";

const LOG_TTL_SECONDS = 3600; // 1 hour log retention in Redis

/**
 * Formats an SSE message frame according to the W3C EventSource standard:
 * event: <name>\n
 * data: <payload>\n\n
 */
export const formatSseEvent = ({ event = "log", data = "", id = null }) => {
  let message = "";
  if (id !== null) message += `id: ${id}\n`;
  if (event) message += `event: ${event}\n`;

  const payload = typeof data === "object" ? JSON.stringify(data) : String(data);
  const lines = payload.split(/\r?\n/);
  for (const line of lines) {
    message += `data: ${line}\n`;
  }

  message += "\n";
  return message;
};

/**
 * Backpressure-safe SSE write.
 * Pauses and waits for the socket 'drain' event if the client TCP buffer is full.
 */
export const writeSseSafe = async (res, message) => {
  if (res.writableEnded || res.destroyed) return false;
  const canContinue = res.write(message);
  if (!canContinue) {
    await new Promise((resolve) => res.once("drain", resolve));
  }
  return true;
};

/**
 * Appends a log line to the Redis history list and publishes to the live channel
 */
export const publishDeploymentLog = async (jobId, data, event = "log") => {
  const logKey = `deployment:logs:${jobId}`;
  const channel = `deployment:channel:${jobId}`;

  const entry = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  try {
    await redisClient.rPush(logKey, entry);
    await redisClient.expire(logKey, LOG_TTL_SECONDS);
    await redisClient.publish(channel, entry);
  } catch (err) {
    console.error(`[LogStreamer Error] Failed to publish log for job #${jobId}:`, err.message);
  }
};

/**
 * Retrieves all stored log entries for a deployment from Redis
 */
export const getDeploymentLogHistory = async (jobId) => {
  const logKey = `deployment:logs:${jobId}`;
  try {
    const rawEntries = await redisClient.lRange(logKey, 0, -1);
    return rawEntries.map((item) => JSON.parse(item));
  } catch (err) {
    console.error(`[LogStreamer Error] Failed to fetch log history for job #${jobId}:`, err.message);
    return [];
  }
};

/**
 * Sets standard SSE headers and disables proxy buffering
 */
export const setSseHeaders = (res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

/**
 * Starts a 15s keep-alive heartbeat and returns a stop function
 */
export const startHeartbeat = (res, intervalMs = 15000) => {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keep-alive\n\n");
    }
  }, intervalMs);

  return () => clearInterval(timer);
};

/**
 * Replays historical logs for late-joiners and page refreshes
 * Returns true if the deployment has already completed
 */
export const replayHistory = async (res, jobId) => {
  const history = await getDeploymentLogHistory(jobId);
  let isComplete = false;

  for (const entry of history) {
    if (res.writableEnded || res.destroyed) break;
    const frame = formatSseEvent({ event: entry.event, data: entry.data });
    await writeSseSafe(res, frame);
    if (entry.event === "complete") {
      isComplete = true;
    }
  }

  return isComplete;
};

/**
 * Manages Redis Pub/Sub subscription and queues early live chunks
 */
export const createLiveSubscriber = async ({ res, jobId, onComplete }) => {
  const channel = `deployment:channel:${jobId}`;
  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  const buffer = [];
  let isFlushed = false;

  const dispatch = async (rawMessage) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      const parsed = JSON.parse(rawMessage);
      const frame = formatSseEvent({ event: parsed.event, data: parsed.data });
      await writeSseSafe(res, frame);

      if (parsed.event === "complete" && onComplete) {
        await onComplete();
      }
    } catch (err) {
      console.error(`[SSE Subscriber Error] Job #${jobId}:`, err.message);
    }
  };

  await subscriber.subscribe(channel, async (message) => {
    if (!isFlushed) {
      buffer.push(message);
      return;
    }
    await dispatch(message);
  });

  return {
    flushQueuedChunks: async () => {
      isFlushed = true;
      while (buffer.length > 0 && !res.writableEnded) {
        await dispatch(buffer.shift());
      }
    },
    unsubscribe: async () => {
      try {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      } catch {}
    },
  };
};

/**
 * The Combined Controller Handler
 */
export const handleDeploymentLogStream = async (req, res) => {
  const { jobId } = req.params;

  setSseHeaders(res);
  const stopHeartbeat = startHeartbeat(res);

  let liveSubscriber = null;
  let isCleanedUp = false;

  const cleanup = async () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    stopHeartbeat();
    if (liveSubscriber) {
      await liveSubscriber.unsubscribe();
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  try {
    // 1. Subscribe first to capture live messages while reading history
    liveSubscriber = await createLiveSubscriber({
      res,
      jobId,
      onComplete: async () => {
        await cleanup();
        res.end();
      },
    });

    // 2. Replay all past logs
    const isAlreadyFinished = await replayHistory(res, jobId);
    if (isAlreadyFinished) {
      await cleanup();
      return res.end();
    }

    // 3. Flush any live chunks that arrived during history fetching
    await liveSubscriber.flushQueuedChunks();
  } catch (err) {
    console.error(`[SSE Handler Error] Job #${jobId}:`, err);
    await cleanup();
    if (!res.writableEnded) res.end();
  }
};

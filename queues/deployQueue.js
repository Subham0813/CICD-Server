import { Queue } from "bullmq";
import { redisClient } from "../configs/redis.js";

export const deployQueue = new Queue("cicd-server-queue", {
  connection: redisClient,
  defaultJobOptions: {
    removeOnComplete: {
      age: 24 * 3600, // keep for 24 hours (in seconds)
      count: 100, // keep at most the last 100 completed deployments
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // keep failed jobs for 7 days for post-mortem debugging
      count: 200, // keep at most 200 failed deployments
    },
  },
});

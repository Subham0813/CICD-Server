import { Queue } from "bullmq";
import { redisClient } from "../configs/redis.js";

export const deployQueue = new Queue("cicd-server-queue", {
  connection: redisClient,
});

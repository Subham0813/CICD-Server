import { createClient } from "redis";

export const getRedisClientMeta = () => {
  const url = process.env.REDIS_URL;

  let urlObj;
  if (url) {
    try {
      urlObj = new URL(url);
    } catch {}
  }

  const username = urlObj?.username || process.env.REDIS_USERNAME || undefined;
  const password = urlObj?.password || process.env.REDIS_PASSWORD || undefined;
  const host = urlObj?.hostname || process.env.REDIS_HOST || "127.0.0.1";
  const port = Number(urlObj?.port) || process.env.REDIS_PORT || 6379;
  return { username, password, host, port, maxRetriesPerRequest: null };
};

const { username, password, host, port } = getRedisClientMeta();
export const redisClient = await createClient({
  username,
  password,
  url: `redis://${host}:${port}`,
})
  .on("connect", () => console.info("RedisClient Connected."))
  .on("error", (err) => console.error("RedisClient Error", err))
  .connect();

process.once("SIGINT", async () => {
  await redisClient.close();
  console.log("RedisClient Disconnected.");
  process.exit(0);
});

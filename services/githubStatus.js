export const setCommitStatus = async ({
  repo,
  commitSha,
  state = "success",
  description = "Deployment completed successfully.",
  context = "Deployment",
}) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn(
      "[GitHub Status] GITHUB_TOKEN not provided in .env. Skipping status update.",
    );
    return;
  }

  const url = `https://api.github.com/repos/${repo}/statuses/${commitSha}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Custom CICD",
      },
      body: JSON.stringify({ state, description, context }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[GitHub Status Error] ${res.status}: ${errText}`);
    } else {
      console.log(
        `[GitHub Status] Marked ${commitSha.slice(0, 7)} as ${state.toUpperCase()}`,
      );
    }
  } catch (err) {
    console.error("[GitHub Status] Network request failed:", err.message);
  }
};

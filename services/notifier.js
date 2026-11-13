/**
 * Slack Notification Service
 * Sends structured Block Kit messages for deployment success, failures, and rollbacks.
 */

export const sendDeploymentNotification = async ({
  repository,
  branch,
  commitSha,
  commitMessage = "No commit message provided",
  commitUrl,
  author,
  status = "success", // 'success' | 'failure'
  duration = "0s",
  depsChanged = false,
  lkgSha = null,
  isDayZero = false,
  errorMessage = null,
}) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(
      "[Notifier] SLACK_WEBHOOK_URL not configured in .env. Skipping Slack alert.",
    );
    return;
  }

  const isSuccess = status === "success";
  const shortSha = commitSha ? commitSha.slice(0, 7) : "unknown";
  const repoUrl = `https://github.com/${repository}`;
  const targetCommitUrl = commitUrl || `${repoUrl}/commit/${commitSha}`;

  // Color bar: Green (#2eb886) for success, Red (#e01e5a) for failure/rollback
  const color = isSuccess ? "#2eb886" : "#e01e5a";
  const title = isSuccess
    ? "🚀 AutoShip: Deployment Succeeded"
    : isDayZero
      ? "⚠️ AutoShip: Initial Deployment (Day 0) Failed"
      : "🚨 AutoShip: Deployment Failed — Auto-Rollback Triggered";

  const strategyText = depsChanged
    ? "📦 Full Install (`npm ci` executed)"
    : "⚡ Fast Deploy (`npm ci` skipped)";

  // Subtitle/Context message
  let contextText = `*Commit Message:* ${commitMessage}`;
  if (!isSuccess) {
    if (isDayZero) {
      contextText += `\n⚠️ *Day 0 Teardown:* No prior LKG on record. Service was terminated and cleaned up to prevent crash-loops.`;
    } else if (lkgSha) {
      contextText += `\n🛡️ *Rollback:* System automatically reverted to LKG: \`${lkgSha.slice(0, 7)}\``;
    }
    if (errorMessage) {
      contextText += `\n❌ *Error:* \`${errorMessage}\``;
    }
  }

  const payload = {
    attachments: [
      {
        color,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: title,
              emoji: true,
            },
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Repository:*\n<${repoUrl}|${repository}>`,
              },
              {
                type: "mrkdwn",
                text: `*Branch:*\n\`${branch}\``,
              },
              {
                type: "mrkdwn",
                text: `*Commit:*\n<${targetCommitUrl}|${shortSha}>`,
              },
              {
                type: "mrkdwn",
                text: `*Author:*\n${author}`,
              },
              {
                type: "mrkdwn",
                text: `*Duration:*\n⏱️ ${duration}`,
              },
              {
                type: "mrkdwn",
                text: `*Build Strategy:*\n${strategyText}`,
              },
            ],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: contextText,
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Notifier Error] Slack returned ${res.status}: ${errText}`);
    } else {
      console.log(`[Notifier] Slack alert delivered successfully (${status}).`);
    }
  } catch (err) {
    console.error("[Notifier] Failed to send Slack alert:", err.message);
  }
};


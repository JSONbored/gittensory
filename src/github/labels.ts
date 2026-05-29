import { Octokit } from "@octokit/core";
import { createInstallationToken } from "./app";

type GitHubLabel = {
  name?: string | null;
};

export async function ensurePullRequestLabel(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  labelName: string,
  options: { createMissingLabel: boolean },
): Promise<{ applied: boolean; created: boolean }> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);

  const token = await createInstallationToken(env, installationId);
  const octokit = new Octokit({ auth: token });
  const existing = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const labels = existing.data as GitHubLabel[];
  if (labels.some((label) => label.name?.toLowerCase() === labelName.toLowerCase())) {
    return { applied: false, created: false };
  }

  let created = false;
  if (options.createMissingLabel) {
    const labelLookup = await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner,
      repo,
      name: labelName,
    }).catch((error: { status?: number }) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (!labelLookup) {
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name: labelName,
        color: "7ee787",
        description: "Gittensor contributor context",
      });
      created = true;
    }
  }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: pullNumber,
    labels: [labelName],
  });
  return { applied: true, created };
}

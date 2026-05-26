import {
  countOpenIssues,
  countOpenPullRequests,
  getLatestRepoGithubTotalsSnapshot,
  getRepository,
  getRepositorySettings,
  listCheckSummaries,
  listAllIssues,
  listAllPullRequests,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listIssues,
  listIssueSignalSample,
  listOtherOpenPullRequests,
  listOpenPullRequests,
  listPullRequestFiles,
  listPullRequestReviews,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepoLabels,
  listRepoSyncStates,
  listRepoSyncSegments,
  listRepositories,
  markInstallationDeleted,
  persistAdvisory,
  recordAuditEvent,
  persistSignalSnapshot,
  recordWebhookEvent,
  replaceCollisionEdges,
  upsertBurdenForecast,
  upsertContributorEvidence,
  upsertContributorScoringProfile,
  upsertInstallation,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
} from "../db/repositories";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  enqueueRepositoryOpenDataBackfill,
  refreshContributorActivity,
  refreshInstallationHealth,
} from "../github/backfill";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { createOrUpdateCheckRun, getInstallationId } from "../github/app";
import { createOrUpdatePrIntelligenceComment } from "../github/comments";
import { fetchPublicContributorProfile } from "../github/public";
import { refreshRegistry } from "../registry/sync";
import { buildIssueAdvisory, buildPullRequestAdvisory } from "../rules/advisory";
import { getOrCreateScoringModelSnapshot, refreshScoringModelSnapshot } from "../scoring/model";
import { buildAndPersistContributorDecisionPack } from "../services/decision-pack";
import {
  buildBurdenForecast,
  buildCollisionEdges,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  detectGittensorContributor,
  shouldPublishPrIntelligenceComment,
} from "../signals/engine";
import { buildPullRequestReviewability } from "../signals/reward-risk";
import type { ContributorEvidenceRecord, GitHubWebhookPayload, JobMessage, JsonValue } from "../types";

export async function processJob(env: Env, message: JobMessage): Promise<void> {
  switch (message.type) {
    case "refresh-registry":
      await refreshRegistry(env);
      return;
    case "backfill-registered-repos":
      if (!message.repoFullName && message.requestedBy !== "test") {
        const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered);
        if (repositories.length > 0) {
          const delayStepSeconds = message.mode === "full" || message.mode === "resume" ? 45 : 15;
          await Promise.all(
            repositories.map((repo, index) => {
              const repoMessage: JobMessage = {
                type: "backfill-registered-repos",
                requestedBy: message.requestedBy,
                repoFullName: repo.fullName,
                ...(message.force === undefined ? {} : { force: message.force }),
                ...(message.mode === undefined ? {} : { mode: message.mode }),
              };
              const delaySeconds = Math.min(index * delayStepSeconds, 900);
              return delaySeconds > 0 ? env.JOBS.send(repoMessage, { delaySeconds }) : env.JOBS.send(repoMessage);
            }),
          );
          return;
        }
      }
      if (message.repoFullName && message.requestedBy !== "test") {
        await enqueueRepositoryOpenDataBackfill(env, {
          repoFullName: message.repoFullName,
          requestedBy: message.requestedBy,
          ...(message.force === undefined ? {} : { force: message.force }),
          ...(message.mode === undefined ? {} : { mode: message.mode }),
        });
        return;
      }
      await backfillRegisteredRepositories(env, {
        ...(message.repoFullName ? { repoFullName: message.repoFullName } : {}),
        requestedBy: message.requestedBy,
        ...(message.force === undefined ? {} : { force: message.force }),
        ...(message.mode === undefined ? {} : { mode: message.mode }),
      });
      return;
    case "backfill-repo-segment":
      await backfillRepositorySegment(env, {
        repoFullName: message.repoFullName,
        segment: message.segment,
        requestedBy: message.requestedBy,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
        ...(message.force === undefined ? {} : { force: message.force }),
      });
      return;
    case "backfill-pr-details":
      await backfillOpenPullRequestDetails(env, {
        repoFullName: message.repoFullName,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
      });
      return;
    case "refresh-installation-health":
      await refreshInstallationHealth(env);
      return;
    case "generate-signal-snapshots":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutRepoSignalSnapshotJobs(env, message.requestedBy);
        return;
      }
      await generateSignalSnapshots(env, message.repoFullName);
      return;
    case "refresh-scoring-model":
      await refreshScoringModelSnapshot(env);
      return;
    case "build-contributor-evidence":
      await buildContributorEvidence(env, message.login);
      return;
    case "build-contributor-decision-packs":
      await buildContributorDecisionPacks(env, message.login);
      return;
    case "refresh-contributor-activity":
      await refreshContributorActivity(env, message.login, message.repoFullName ? { repoFullName: message.repoFullName } : {});
      return;
    case "build-burden-forecasts":
      await buildBurdenForecasts(env, message.repoFullName);
      return;
    case "repair-data-fidelity":
      await repairDataFidelity(env, message.requestedBy);
      return;
    case "github-webhook":
      await processGitHubWebhook(env, message.deliveryId, message.eventName, message.payload);
      return;
  }
}

async function buildContributorDecisionPacks(env: Env, login?: string): Promise<void> {
  const logins = login ? [login] : await discoverContributorLogins(env);
  for (const contributorLogin of logins) await buildAndPersistContributorDecisionPack(env, contributorLogin);
}

async function fanOutRepoSignalSnapshotJobs(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  await Promise.all(
    repositories.map((repo, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName: repo.fullName,
      };
      const delaySeconds = Math.min(index * 10, 600);
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "signals.snapshot_fanout",
    outcome: "queued",
    metadata: { repoCount: repositories.length, requestedBy },
  });
}

async function repairDataFidelity(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
  const [repositories, segments] = await Promise.all([listRepositories(env), listRepoSyncSegments(env)]);
  const requiredSegments = new Set(["labels", "open_issues", "open_pull_requests"]);
  const segmentsByRepo = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (requiredSegments.has(segment.segment) && segment.status === "complete") {
      const complete = segmentsByRepo.get(segment.repoFullName) ?? new Set<string>();
      complete.add(segment.segment);
      segmentsByRepo.set(segment.repoFullName, complete);
    }
  }
  const registeredRepos = repositories.filter((repo) => repo.isRegistered);
  const repairs = [];
  const signalRefreshes = [];
  for (const repo of registeredRepos) {
    const complete = segmentsByRepo.get(repo.fullName) ?? new Set<string>();
    const missing = [...requiredSegments].filter((segment) => !complete.has(segment));
    if (missing.length > 0) {
      repairs.push({ repoFullName: repo.fullName, missing });
      continue;
    }
    signalRefreshes.push(repo.fullName);
  }
  await Promise.all([
    ...repairs.map((repair, index) => {
      const message: JobMessage = {
        type: "backfill-registered-repos",
        requestedBy,
        repoFullName: repair.repoFullName,
        mode: "resume",
      };
      const delaySeconds = Math.min(index * 30, 900);
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
    ...signalRefreshes.slice(0, 50).map((repoFullName, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName,
      };
      const delaySeconds = repairs.length > 0 || index > 0 ? Math.min(60 + index * 10, 900) : 0;
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
  ]);
  await recordAuditEvent(env, {
    eventType: "sync.fidelity_repair",
    outcome: repairs.length > 0 ? "queued" : "completed",
    metadata: { requestedBy, repairCount: repairs.length, signalRefreshCount: signalRefreshes.length, repairs: repairs.slice(0, 25) },
  });
}

async function discoverContributorLogins(env: Env): Promise<string[]> {
  const [pullRequests, issues] = await Promise.all([listAllPullRequests(env), listAllIssues(env)]);
  return [...new Set([...pullRequests, ...issues].flatMap((record) => (record.authorLogin ? [record.authorLogin] : [])))].slice(0, 200);
}

async function buildContributorEvidence(env: Env, login?: string): Promise<void> {
  const [allPullRequests, allIssues, repositories, syncStates, snapshot] = await Promise.all([
    listAllPullRequests(env),
    listAllIssues(env),
    listRepositories(env),
    listRepoSyncStates(env),
    getOrCreateScoringModelSnapshot(env),
  ]);
  const logins = login ? [login] : [...new Set([...allPullRequests, ...allIssues].flatMap((record) => (record.authorLogin ? [record.authorLogin] : [])))].slice(0, 500);
  for (const contributorLogin of logins) {
    const [github, contributorPullRequests, contributorIssues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(contributorLogin),
      listContributorPullRequests(env, contributorLogin),
      listContributorIssues(env, contributorLogin),
      listContributorRepoStats(env, contributorLogin),
      fetchGittensorContributorSnapshot(contributorLogin),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    const profile = buildContributorProfile(contributorLogin, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
    const fit = buildContributorFit(profile, repositories, allIssues, allPullRequests, syncStates, repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: contributorLogin, fit, scoringSnapshot: snapshot });
    const outcomeHistory = buildContributorOutcomeHistory({ login: contributorLogin, profile, repositories, pullRequests: allPullRequests, issues: allIssues, repoStats });
    const strategy = buildContributorStrategy({ login: contributorLogin, fit, scoringProfile, scoringSnapshot: snapshot, outcomeHistory });
    const evidence: ContributorEvidenceRecord = {
      login: contributorLogin,
      generatedAt: scoringProfile.generatedAt,
      payload: {
        pullRequests: scoringProfile.evidence.registeredRepoPullRequests,
        mergedPullRequests: scoringProfile.evidence.mergedPullRequests,
        openPullRequests: scoringProfile.evidence.openPullRequests,
        stalePullRequests: scoringProfile.evidence.stalePullRequests,
        unlinkedPullRequests: scoringProfile.evidence.unlinkedPullRequests,
        issueDiscoveryReports: scoringProfile.evidence.issueDiscoveryReports,
        languageMatches: scoringProfile.evidence.languageMatches,
        credibilityAssumption: scoringProfile.evidence.credibilityAssumption,
      },
    };
    await upsertContributorEvidence(env, evidence);
    await upsertContributorScoringProfile(env, {
      login: contributorLogin,
      scoringModelSnapshotId: snapshot.id,
      payload: scoringProfile as unknown as Record<string, JsonValue>,
      generatedAt: scoringProfile.generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "contributor-outcome-history",
      targetKey: contributorLogin,
      payload: outcomeHistory as unknown as Record<string, JsonValue>,
      generatedAt: outcomeHistory.generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "contributor-strategy",
      targetKey: contributorLogin,
      payload: strategy as unknown as Record<string, JsonValue>,
      generatedAt: strategy.generatedAt,
    });
  }
}

async function buildBurdenForecasts(env: Env, repoFullName?: string): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!repoFullName || repo.fullName === repoFullName));
  for (const repo of repositories) {
    const [issues, pullRequests, recentMergedPullRequests, queueCounts] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
    ]);
    const forecast = buildBurdenForecast(repo, issues, pullRequests, buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests), 30, queueCounts);
    await upsertBurdenForecast(env, {
      repoFullName: repo.fullName,
      payload: forecast as unknown as Record<string, JsonValue>,
      generatedAt: forecast.generatedAt,
    });
  }
}

export async function generateSignalSnapshots(env: Env, repoFullName?: string): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!repoFullName || repo.fullName === repoFullName));
  for (const repo of repositories) {
    const [issues, pullRequests, recentMergedPullRequests, labels, queueCounts] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      listRepoLabels(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
    ]);
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
    const configQuality = buildConfigQuality(repo, issues, pullRequests, repo.fullName);
    const labelAudit = buildLabelAudit(repo, labels, issues, pullRequests, repo.fullName);
    const maintainerLane = buildMaintainerLaneReport(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    const maintainerCutReadiness = buildMaintainerCutReadiness(repo, issues, pullRequests, repo.fullName, queueCounts, collisions);
    const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    await replaceCollisionEdges(env, repo.fullName, buildCollisionEdges(collisions));
    const generatedAt = new Date().toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "queue-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: queueHealth as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "config-quality",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: configQuality as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "label-audit",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: labelAudit as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-lane",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerLane as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-cut-readiness",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerCutReadiness as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "contributor-intake-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: contributorIntakeHealth as unknown as Record<string, never>,
      generatedAt,
    });
  }
}

async function loadOpenQueueCounts(env: Env, repoFullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([getLatestRepoGithubTotalsSnapshot(env, repoFullName), countOpenIssues(env, repoFullName), countOpenPullRequests(env, repoFullName)]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

async function processGitHubWebhook(env: Env, deliveryId: string, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  try {
    if (eventName === "installation" && payload.action === "deleted" && payload.installation?.id) {
      await markInstallationDeleted(env, payload.installation.id);
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    await upsertInstallation(env, payload);

    const installationId = getInstallationId(payload);
    if (payload.repositories) {
      for (const repo of payload.repositories) await upsertRepositoryFromGitHub(env, repo, installationId ?? undefined);
    }
    if (payload.repository) await upsertRepositoryFromGitHub(env, payload.repository, installationId ?? undefined);

    if (payload.repository?.full_name && payload.pull_request) {
      const pr = await upsertPullRequestFromGitHub(env, payload.repository.full_name, payload.pull_request);
      const repo = await getRepository(env, payload.repository.full_name);
      const [otherOpenPullRequests, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
        listOtherOpenPullRequests(env, payload.repository.full_name, pr.number),
        listIssues(env, payload.repository.full_name),
        listPullRequests(env, payload.repository.full_name),
        listPullRequestFiles(env, payload.repository.full_name, pr.number),
        listPullRequestReviews(env, payload.repository.full_name, pr.number),
        listCheckSummaries(env, payload.repository.full_name, pr.number),
        listRecentMergedPullRequests(env, payload.repository.full_name),
      ]);
      const reviewability = buildPullRequestReviewability({
        repo,
        pullRequest: pr,
        issues,
        pullRequests,
        files,
        reviews,
        checks,
        recentMergedPullRequests,
        repoFullName: payload.repository.full_name,
        pullNumber: pr.number,
      });
      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests, reviewabilityText: reviewability.privateSummary });
      await persistAdvisory(env, advisory);
      if (installationId && advisory.headSha) await createOrUpdateCheckRun(env, installationId, payload.repository.full_name, advisory);
      if (installationId) {
        await maybePublishPrIntelligenceComment(env, installationId, payload.repository.full_name, pr, repo).catch((error) => {
          console.error(
            JSON.stringify({
              level: "warn",
              event: "pr_intelligence_comment_failed",
              deliveryId,
              repository: payload.repository?.full_name,
              pullNumber: pr.number,
              error: error instanceof Error ? error.message : "unknown error",
            }),
          );
        });
      }
    }

    if (payload.repository?.full_name && payload.issue && !payload.issue.pull_request) {
      const issue = await upsertIssueFromGitHub(env, payload.repository.full_name, payload.issue);
      const repo = await getRepository(env, payload.repository.full_name);
      const advisory = buildIssueAdvisory(repo, issue);
      await persistAdvisory(env, advisory);
    }

    await recordWebhookEvent(env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId: payload.installation?.id,
      repositoryFullName: payload.repository?.full_name,
      payloadHash: "processed",
      status: "processed",
    });
  } catch (error) {
    await recordWebhookEvent(env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId: payload.installation?.id,
      repositoryFullName: payload.repository?.full_name,
      payloadHash: "processed",
      status: "error",
      errorSummary: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
}

async function maybePublishPrIntelligenceComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  repo: Awaited<ReturnType<typeof getRepository>>,
): Promise<void> {
  const settings = await getRepositorySettings(env, repoFullName);
  if (settings.commentMode === "off") return;
  const author = pr.authorLogin;
  if (!author) return;

  const [contributorPullRequests, contributorIssues, repoIssues, repoPullRequests, github, cachedRepoStats, gittensorSnapshot] = await Promise.all([
    listContributorPullRequests(env, author),
    listContributorIssues(env, author),
    listIssues(env, repoFullName),
    listPullRequests(env, repoFullName),
    fetchPublicContributorProfile(author),
    listContributorRepoStats(env, author),
    fetchGittensorContributorSnapshot(author),
  ]);
  const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
  const detection = detectGittensorContributor(author, pr, contributorPullRequests, contributorIssues, repoStats);
  if (!shouldPublishPrIntelligenceComment(settings, detection)) return;

  const profile = buildContributorProfile(author, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
  const collisions = buildCollisionReport(repoFullName, repoIssues, repoPullRequests);
  const queueHealth = buildQueueHealth(repo, repoIssues, repoPullRequests, collisions);
  const preflight = buildPreflightResult(
    {
      repoFullName,
      contributorLogin: author,
      title: pr.title,
      body: pr.body ?? undefined,
      labels: pr.labels,
      linkedIssues: pr.linkedIssues,
      authorAssociation: pr.authorAssociation ?? undefined,
    },
    repo,
    repoIssues,
    repoPullRequests,
  );
  const body = buildPublicPrIntelligenceComment({
    repo,
    pr,
    profile,
    detection,
    queueHealth,
    collisions,
    preflight,
    settings,
  });
  await createOrUpdatePrIntelligenceComment(env, installationId, repoFullName, pr.number, body);
}

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

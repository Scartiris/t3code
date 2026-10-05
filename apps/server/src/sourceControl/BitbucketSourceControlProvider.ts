import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

import * as BitbucketApi from "./BitbucketApi.ts";
import type { NormalizedBitbucketPullRequestRecord } from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: NormalizedBitbucketPullRequestRecord): ChangeRequest {
  return {
    provider: "bitbucket",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "bitbucket",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
                operation: "listChangeRequests",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: t("sourceControl.bitbucketSourceControlProvider.listChangeRequestsFailed"),
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket",
              operation: "getChangeRequest",
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: t("sourceControl.bitbucketSourceControlProvider.getChangeRequestFailed"),
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
                operation: "createChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: t("sourceControl.bitbucketSourceControlProvider.createChangeRequestFailed"),
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      bitbucket.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket",
              operation: "getRepositoryCloneUrls",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to get repository clone URLs.",
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      bitbucket.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket",
              operation: "createRepository",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: t("sourceControl.bitbucketSourceControlProvider.createRepositoryFailed"),
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
                operation: "getDefaultBranch",
                cwd: input.cwd,
                detail: t("sourceControl.bitbucketSourceControlProvider.getDefaultBranchFailed"),
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      bitbucket
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
                operation: "checkoutChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: t(
                  "sourceControl.bitbucketSourceControlProvider.checkoutChangeRequestFailed",
                ),
                cause: error,
              }),
          ),
        ),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return {
    type: "api",
    kind: "bitbucket",
    label: "Bitbucket",
    installHint: t("sourceControl.bitbucketSourceControlProvider.installHint"),
    probeAuth: bitbucket.probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});

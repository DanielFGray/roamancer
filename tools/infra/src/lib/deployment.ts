export interface DeploymentRoots {
  readonly projects: string;
  readonly staticFiles: string;
}

export const deploymentRoots = (overrides: Partial<DeploymentRoots> = {}): DeploymentRoots => ({
  projects: overrides.projects ?? "/srv/projects",
  staticFiles: overrides.staticFiles ?? "/srv/www",
});

export interface DeploymentPaths {
  readonly bareRepo: string;
  readonly worktree: string;
  readonly service: string;
  readonly serviceCandidate: string;
  readonly staticFiles: string;
}

export const deploymentPaths = (
  name: string,
  stage: string,
  roots: DeploymentRoots = deploymentRoots(),
): DeploymentPaths => ({
  bareRepo: `${roots.projects}/${name}.git`,
  worktree: `${roots.projects}/${name}/worktrees/${stage}`,
  service: `${roots.projects}/${name}/stages/${stage}`,
  serviceCandidate: `${roots.projects}/${name}/stages/${stage}.new`,
  staticFiles: `${roots.staticFiles}/${name}/stages/${stage}`,
});

export const worktreeParent = (name: string, roots: DeploymentRoots = deploymentRoots()) =>
  `${roots.projects}/${name}/worktrees`;

export const deploymentNames = (name: string, stage: string) =>
  ({
    serviceUnit: `infra-${name}-${stage}`,
    candidateUnit: `infra-${name}-${stage}-new`,
    stageSnippet: `infra--${name}--stage--${stage}.caddyfile`,
    productionSnippet: `infra--${name}--production.caddyfile`,
  }) as const;

export const previewHost = (hash: string, domain: string) => `${hash}-preview.${domain}`;

export const previewUrl = (hash: string, domain: string) => `https://${previewHost(hash, domain)}`;

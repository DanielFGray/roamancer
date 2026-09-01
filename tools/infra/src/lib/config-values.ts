/** Build configuration paths from explicit input. */
export const configPaths = (home: string) => {
  const configHome = `${home}/.config/infra`;
  return {
    configHome,
    apiTokenFile: `${configHome}/api-token`,
    webhookSecretFile: `${configHome}/webhook-secret`,
    // Operator-facing: the CLI's own admin-level token, read when running
    // `infra vault ...` by hand. Never written by Ansible to a deployed host.
    openBaoTokenFile: `${configHome}/openbao-token`,
    // Agent-facing: narrow, renewable tokens Ansible mints at bootstrap and
    // writes only to the deployed agent host. See ts-42195e.
    openBaoSecretsTokenFile: `${configHome}/openbao-secrets-token`,
    openBaoBackupsTokenFile: `${configHome}/openbao-backups-token`,
  } as const;
};

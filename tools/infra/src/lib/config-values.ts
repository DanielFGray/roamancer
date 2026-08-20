/** Build configuration paths from explicit input. */
export const configPaths = (home: string) => {
  const configHome = `${home}/.config/infra`
  return {
    configHome,
    apiTokenFile: `${configHome}/api-token`,
    webhookSecretFile: `${configHome}/webhook-secret`,
    openBaoTokenFile: `${configHome}/openbao-token`,
  } as const
}

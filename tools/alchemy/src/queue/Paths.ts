/**
 * On-disk paths the queue front end and job units share. Tests pass a temp directory.
 */
export type Paths = {
  readonly database: string;
  readonly socket: string;
  readonly tokenFile: string;
  /** Where the front end keeps uploaded trees until their build job ends. */
  readonly spool: string;
  /**
   * The bare repositories the operator pushes apps to, `<app>.git` each, which reconcile
   * reads. nixos/modules/alchemy-runner.nix makes this folder and one repository per app in
   * the site policy.
   */
  readonly repositories: string;
};

export const production: Paths = {
  database: "/var/lib/alchemy/queue.sqlite",
  socket: "/run/alchemy/submit.sock",
  tokenFile: "/run/alchemy/openbao.token",
  spool: "/var/lib/alchemy/builds",
  repositories: "/srv/git",
};

/** Paths rooted under `root` (a temp directory in tests). */
export const under = (root: string): Paths => ({
  database: `${root}/queue.sqlite`,
  socket: `${root}/submit.sock`,
  tokenFile: `${root}/openbao.token`,
  spool: `${root}/builds`,
  repositories: `${root}/repositories`,
});

/** The spool file of the upload `spool` names. */
export const spoolFile = (paths: Paths, spool: string) => `${paths.spool}/${spool}.tar`;

/** The bare repository of `app` in the `repositories` folder. */
export const repositoryOf = (repositories: string, app: string) => `${repositories}/${app}.git`;

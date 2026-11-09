/**
 * On-disk paths the queue front end and job units share. Tests pass a temp directory.
 */
export type Paths = {
  readonly database: string;
  readonly socket: string;
  readonly tokenFile: string;
  /** Where the front end keeps uploaded trees until their build job ends. */
  readonly spool: string;
  /** Bare repositories reconcile fetches `main` into, one per app. */
  readonly reconcileCache: string;
  /** The deploy keys: `<app>` is the private key and `<app>.pub` its public half. */
  readonly deployKeys: string;
};

export const production: Paths = {
  database: "/var/lib/alchemy/queue.sqlite",
  socket: "/run/alchemy/submit.sock",
  tokenFile: "/run/alchemy/openbao.token",
  spool: "/var/lib/alchemy/builds",
  reconcileCache: "/var/lib/alchemy/reconcile",
  deployKeys: "/var/lib/alchemy-deploy-keys",
};

/** Paths rooted under `root` (a temp directory in tests). */
export const under = (root: string): Paths => ({
  database: `${root}/queue.sqlite`,
  socket: `${root}/submit.sock`,
  tokenFile: `${root}/openbao.token`,
  spool: `${root}/builds`,
  reconcileCache: `${root}/reconcile`,
  deployKeys: `${root}/deploy-keys`,
});

/** The spool file of the upload `spool` names. */
export const spoolFile = (paths: Paths, spool: string) => `${paths.spool}/${spool}.tar`;

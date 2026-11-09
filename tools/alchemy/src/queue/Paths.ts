/**
 * On-disk paths the queue front end and job units share. Tests pass a temp directory.
 */
export type Paths = {
  readonly database: string;
  readonly socket: string;
  readonly tokenFile: string;
  /** Where the front end keeps uploaded trees until their build job ends. */
  readonly spool: string;
};

export const production: Paths = {
  database: "/var/lib/alchemy/queue.sqlite",
  socket: "/run/alchemy/submit.sock",
  tokenFile: "/run/alchemy/openbao.token",
  spool: "/var/lib/alchemy/builds",
};

/** Paths rooted under `root` (a temp directory in tests). */
export const under = (root: string): Paths => ({
  database: `${root}/queue.sqlite`,
  socket: `${root}/submit.sock`,
  tokenFile: `${root}/openbao.token`,
  spool: `${root}/builds`,
});

/** The spool file of the upload `spool` names. */
export const spoolFile = (paths: Paths, spool: string) => `${paths.spool}/${spool}.tar`;

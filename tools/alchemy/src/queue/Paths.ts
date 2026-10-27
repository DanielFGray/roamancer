/**
 * On-disk paths the queue front end and job units share. Tests pass a temp directory.
 */
export type Paths = {
  readonly database: string;
  readonly socket: string;
  readonly tokenFile: string;
};

export const production: Paths = {
  database: "/var/lib/alchemy/queue.sqlite",
  socket: "/run/alchemy/submit.sock",
  tokenFile: "/run/alchemy/openbao.token",
};

/** Paths rooted under `root` (a temp directory in tests). */
export const under = (root: string): Paths => ({
  database: `${root}/queue.sqlite`,
  socket: `${root}/submit.sock`,
  tokenFile: `${root}/openbao.token`,
});

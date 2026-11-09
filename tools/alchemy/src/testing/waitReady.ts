/**
 * Poll `probe` until it answers true, for test fixtures that start a server
 * (a Postgres container, `bao -dev`) and must wait for it to listen.
 *
 * The deadline is time, not a count of tries: a loaded workstation can take
 * many seconds to start a container. It stays under the 30 s that the test
 * script gives each hook (`bun test --timeout`), so a fixture that never comes
 * up fails with its own message rather than with the hook timeout.
 */
export const waitReady = async (
  what: string,
  probe: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not become ready within 25 s`);
};

// Service modules read config during import. Keep Vitest away from the
// operator's real config directory without changing production safety checks.
process.env.HOME = "/tmp/infra-test-home"

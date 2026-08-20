// Deployment boundary tests replace process execution, so Bun's runtime
// implementation is not needed when service modules are loaded by Vitest.
export const spawn = () => {
  throw new Error("The Bun process boundary is not available in unit tests")
}

export class Database {
  constructor() {
    throw new Error("The Bun SQLite boundary is not available in unit tests")
  }
}

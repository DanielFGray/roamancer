import { Context } from "effect";

export class AgentSecrets extends Context.Tag("AgentSecrets")<
  AgentSecrets,
  {
    readonly apiToken: string | undefined;
    readonly webhookSecret: string | undefined;
  }
>() {}

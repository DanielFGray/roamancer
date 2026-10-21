import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/http"
import { layer as caddyLayer } from "./src/Caddy.ts"
import * as NomadLive from "./src/Nomad.ts"
import * as OperationHistory from "./src/OperationJournal.ts"
import * as ReleaseManifest from "./src/ReleaseManifest.ts"
import { ReleaseSet, ReleaseSetProvider } from "./src/ReleaseSet.ts"

const providers = ReleaseSetProvider().pipe(
  Layer.provide(NomadLive.layer()),
  Layer.provide(caddyLayer()),
  Layer.provide(OperationHistory.layer()),
  Layer.provide(FetchHttpClient.layer),
  Layer.orDie
)

const stack = Alchemy.Stack(
  "StagedReleases",
  { providers, state: Alchemy.localState() },
  Effect.gen(function*() {
    const props = yield* ReleaseManifest.load()
    const releaseSet = yield* ReleaseSet(props.name, props)
    return {
      selectedRelease: releaseSet.selectedRelease,
      candidateRelease: releaseSet.candidateRelease,
      previewUrl: releaseSet.previewUrl
    }
  })
)

export default stack

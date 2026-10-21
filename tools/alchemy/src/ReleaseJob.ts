import * as Schema from "effect/Schema"

const ResourceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/))
const ReleaseId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/))
const HostName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]+$/))
const HealthPath = Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]*$/))

export const Release = Schema.Struct({
  id: ReleaseId,
  image: Schema.String.check(Schema.isPattern(/^.+@sha256:[a-f0-9]{64}$/))
})
export type Release = typeof Release.Type

export const ReleaseSetProps = Schema.Struct({
  name: ResourceName,
  scheme: Schema.Literals(["http", "https"]),
  domain: HostName,
  containerPort: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535)
  ),
  healthPath: HealthPath,
  cpu: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  memoryMB: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  releases: Schema.Array(Release),
  selectedRelease: ReleaseId,
  candidateRelease: Schema.optionalKey(Schema.OptionFromNullOr(ReleaseId))
})
export type ReleaseSetProps = typeof ReleaseSetProps.Type

export const previewHost = (props: ReleaseSetProps, release: Release) =>
  `${release.id}.${props.domain}`

export const jobName = (props: ReleaseSetProps, release: Release) =>
  `${props.name}-${release.id}`

/** Render a stateless release job with a Nomad-assigned host port. */
export const toJobSpec = (props: ReleaseSetProps, release: Release, owner: string) => {
  const name = jobName(props, release)
  return {
    ID: name,
    Name: name,
    Type: "service",
    Datacenters: ["dc1"],
    Meta: {
      "alchemy.owner": owner,
      "alchemy.provider": "Nomad.ReleaseSet",
      "alchemy.release": release.id
    },
    TaskGroups: [{
      Name: "app",
      Count: 1,
      Networks: [{ DynamicPorts: [{ Label: "http", To: props.containerPort }] }],
      Services: [{
        Name: name,
        PortLabel: "http",
        Provider: "nomad",
        Checks: [{
          Name: "http",
          Type: "http",
          Path: props.healthPath,
          Interval: 5_000_000_000,
          Timeout: 2_000_000_000,
          OnUpdate: "require_healthy"
        }]
      }],
      Tasks: [{
        Name: "app",
        Driver: "podman",
        Config: { image: release.image, network_mode: "bridge", ports: ["http"] },
        Resources: { CPU: props.cpu, MemoryMB: props.memoryMB }
      }]
    }],
    Update: {
      MaxParallel: 1,
      HealthCheck: "checks",
      MinHealthyTime: 10_000_000_000,
      HealthyDeadline: 180_000_000_000,
      ProgressDeadline: 600_000_000_000,
      AutoRevert: true
    }
  }
}

export type ReleaseJobSpec = ReturnType<typeof toJobSpec>

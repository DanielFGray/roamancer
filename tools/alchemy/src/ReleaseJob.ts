import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { progressDeadlineMillis } from "./Job.ts";

const ResourceName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const ReleaseId = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const HostName = S.String.check(S.isPattern(/^[A-Za-z0-9.-]+$/));
const HealthPath = S.String.check(S.isPattern(/^\/[A-Za-z0-9_./-]*$/));

export const Release = S.Struct({
  id: ReleaseId,
  image: S.String.check(S.isPattern(/^.+@sha256:[a-f0-9]{64}$/)),
});
export type Release = typeof Release.Type;

export const ReleaseSetProps = S.Struct({
  name: ResourceName,
  scheme: S.Literals(["http", "https"]),
  domain: HostName,
  containerPort: S.Number.check(S.isInt(), S.isGreaterThan(0), S.isLessThanOrEqualTo(65_535)),
  healthPath: HealthPath,
  cpu: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  memoryMB: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  releases: S.Array(Release),
  selectedRelease: ReleaseId,
  candidateRelease: S.optionalKey(S.OptionFromNullOr(ReleaseId)),
});
export type ReleaseSetProps = typeof ReleaseSetProps.Type;

export const candidateOf = (props: ReleaseSetProps) =>
  Option.isOption(props.candidateRelease) ? props.candidateRelease : Option.none<string>();

export const previewHost = (props: ReleaseSetProps, release: Release) =>
  `${release.id}.${props.domain}`;

export const jobName = (props: ReleaseSetProps, release: Release) => `${props.name}-${release.id}`;

/**
 * The Traefik route tags for one release's Nomad service. Traefik reads them
 * from Nomad as they change, so the route follows the allocation's address
 * and port with no reconcile.
 *
 * The selected release answers the stable host and the candidate answers its
 * preview host. Any other release is kept only for rollback and gets no tags,
 * so Traefik ignores it. Changing tags is an in-place Nomad update, so a
 * promotion moves a route without restarting either release.
 *
 * Traefik also checks the service's health itself: Nomad registers a service
 * as soon as its allocation starts, before the service is ready.
 */
export const routeTags = (props: ReleaseSetProps, release: Release): ReadonlyArray<string> => {
  const name = jobName(props, release);
  const host =
    release.id === props.selectedRelease
      ? Option.some({ router: `${name}-stable`, host: props.domain })
      : Option.filter(candidateOf(props), (id) => id === release.id).pipe(
          Option.map(() => ({ router: `${name}-preview`, host: previewHost(props, release) })),
        );
  return Option.match(host, {
    onNone: () => [],
    onSome: ({ router, host }) => [
      "traefik.enable=true",
      `traefik.http.services.${name}.loadbalancer.healthcheck.path=${props.healthPath}`,
      `traefik.http.services.${name}.loadbalancer.healthcheck.interval=5s`,
      `traefik.http.middlewares.${name}-release.headers.customresponseheaders.X-Alchemy-Release=${release.id}`,
      `traefik.http.routers.${router}.rule=Host(\`${host}\`)`,
      `traefik.http.routers.${router}.service=${name}`,
      `traefik.http.routers.${router}.middlewares=${name}-release`,
    ],
  });
};

/** Render a stateless release job with a Nomad-assigned host port. */
export const toJobSpec = (props: ReleaseSetProps, release: Release, owner: string) => {
  const name = jobName(props, release);
  return {
    ID: name,
    Name: name,
    Type: "service",
    Datacenters: ["dc1"],
    Meta: {
      "alchemy.owner": owner,
      "alchemy.provider": "Nomad.ReleaseSet",
      "alchemy.release": release.id,
    },
    TaskGroups: [
      {
        Name: "app",
        Count: 1,
        Networks: [{ DynamicPorts: [{ Label: "http", To: props.containerPort }] }],
        Services: [
          {
            Name: name,
            PortLabel: "http",
            Provider: "nomad",
            Tags: routeTags(props, release),
            Checks: [
              {
                Name: "http",
                Type: "http",
                Path: props.healthPath,
                Interval: 5_000_000_000,
                Timeout: 2_000_000_000,
                OnUpdate: "require_healthy",
              },
            ],
          },
        ],
        Tasks: [
          {
            Name: "app",
            Driver: "podman",
            Config: { image: release.image, network_mode: "bridge", ports: ["http"] },
            Resources: { CPU: props.cpu, MemoryMB: props.memoryMB },
          },
        ],
      },
    ],
    Update: {
      MaxParallel: 1,
      HealthCheck: "checks",
      MinHealthyTime: 10_000_000_000,
      HealthyDeadline: 180_000_000_000,
      ProgressDeadline: progressDeadlineMillis * 1_000_000,
      AutoRevert: true,
    },
  };
};

export type ReleaseJobSpec = ReturnType<typeof toJobSpec>;

/** What a build job may use. A leaf module: cartridges and the queue schema both read it. */
import { Schema as S } from "effect";

/** What the job may use above its 256 MB reservation, in MB; the worker node has 4096 MB in all. */
export const BuildMemoryMB = S.Int.check(S.isBetween({ minimum: 256, maximum: 4096 }));

/** The cap a build gets unless its app's cartridge sets `build.memoryMB`. */
export const defaultBuildMemoryMB = 2048;

import { asanaHandlers } from "./asana/sync";
import type { JobRegistry } from "./jobs";
import { metaHandlers } from "./meta/sync";

export const jobRegistry: JobRegistry = { ...asanaHandlers, ...metaHandlers };

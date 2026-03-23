import path from "node:path";

import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";

export interface FilesystemPermissionPolicy {
  hardDeny: string[];
  deny: string[];
}

export interface SystemPermissionPolicy {
  fs: {
    read: FilesystemPermissionPolicy;
    write: FilesystemPermissionPolicy;
  };
  db: {
    read: boolean;
    write: boolean;
  };
}

function subtree(value: string): string {
  return path.join(value, "**");
}

export const DEFAULT_SYSTEM_POLICY: SystemPermissionPolicy = {
  fs: {
    read: {
      hardDeny: [
        subtree(POKECLAW_SYSTEM_DIR),
        subtree(path.join("~", ".ssh")),
        subtree(path.join("~", ".gnupg")),
        subtree(path.join("~", ".aws")),
        subtree(path.join("~", ".azure")),
        subtree(path.join("~", ".gcloud")),
        subtree(path.join("~", ".kube")),
        subtree(path.join("~", ".docker")),
      ],
      deny: [],
    },
    write: {
      hardDeny: [
        subtree(POKECLAW_SYSTEM_DIR),
        subtree(path.join("~", ".ssh")),
        subtree(path.join("~", ".gnupg")),
        subtree(path.join("~", ".aws")),
        subtree(path.join("~", ".azure")),
        subtree(path.join("~", ".gcloud")),
        subtree(path.join("~", ".kube")),
        subtree(path.join("~", ".docker")),
      ],
      deny: [],
    },
  },
  db: {
    read: true,
    write: true,
  },
};

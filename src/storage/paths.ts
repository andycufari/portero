/**
 * Storage paths
 */

export interface StoragePaths {
  approvalsJson: string;
  grantsJson: string;
  rulesJson: string;
  tasksJson: string;
  auditNdjson: string;
}

export function defaultStoragePaths(baseDir: string = './data'): StoragePaths {
  return {
    approvalsJson: `${baseDir}/approvals.json`,
    grantsJson: `${baseDir}/grants.json`,
    rulesJson: `${baseDir}/rules.json`,
    tasksJson: `${baseDir}/tasks.json`,
    auditNdjson: `${baseDir}/audit.ndjson`,
  };
}

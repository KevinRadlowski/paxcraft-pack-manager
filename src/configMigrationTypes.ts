/** Pack Manager mirror of launcher manifest config migration contract (schema 6 optional field). */

export type ConfigMigrationLeafValue = boolean | number | string | null;

export interface ConfigMigrationSetEntry {
  path: string;
  value: ConfigMigrationLeafValue;
}

export interface ManifestConfigMigration {
  id: string;
  configPath: string;
  fromPackVersions?: string[];
  set: ConfigMigrationSetEntry[];
}

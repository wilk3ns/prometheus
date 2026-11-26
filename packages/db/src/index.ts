export {
  connectAs,
  DbRoleMismatchError,
  type DbRole,
  type DbConnectionOptions,
  type Database,
} from './factory.js';
export {
  withSerializable,
  SerializableRetriesExhaustedError,
  type SerializableOptions,
} from './serializable.js';
export { pgErrorCode, PG_INSUFFICIENT_PRIVILEGE } from './pg-errors.js';
export type {
  DB,
  WikiCrawlTarget,
  WikiOfficialDomainAllowlist,
  WikiSourceSnapshot,
  Json,
} from './generated/db.js';

import type {
  Citation,
  DiscoveredLink,
  SnapshotErrorCode,
  LayerFieldsMap,
  RevisionActor,
  SliceCard,
  SliceCardKind,
  SlotCompleteness,
  VerificationDepth,
  WikiLayer,
  WikiStatus,
} from '@prometheus/contracts';

/**
 * Persistence port of the wiki-v2.0 layer tables (implemented over the `wiki_writer` connection only).
 * Every write is versioned (optimistic: `expectedVersion`, 0 = new node) and appends a `wiki.node_revision`.
 */

export interface StoredNode<L extends WikiLayer = WikiLayer> {
  readonly layer: L;
  readonly nodeKey: string;
  readonly rowId: string;
  readonly version: number;
  readonly depth: VerificationDepth;
  readonly score: number | null;
  /** `program_season_spec.wiki_status`; `null` for layers without a status column. */
  readonly wikiStatus: WikiStatus | null;
  readonly fields: LayerFieldsMap[L];
  readonly lockedPaths: readonly string[];
  readonly citations: readonly Citation[];
  readonly slotCompleteness: SlotCompleteness;
}

export interface NodeWrite<L extends WikiLayer = WikiLayer> {
  readonly layer: L;
  readonly nodeKey: string;
  readonly fields: LayerFieldsMap[L];
  readonly depth: VerificationDepth;
  readonly score: number | null;
  readonly citations: readonly Citation[];
  readonly slotCompleteness: SlotCompleteness;
  /** Required for PROGRAM_SPEC, ignored elsewhere. */
  readonly wikiStatus: WikiStatus | null;
  /** Locked paths to store (kept from the existing row unless a human edit changes them). */
  readonly lockedPaths: readonly string[];
  readonly expectedVersion: number;
  readonly actor: RevisionActor;
  readonly reason: string;
  readonly verifiedAt: Date;
  /**
   * Provenance of the evidence (P1, recorded in the revision): `VERIFIED_CITATIONS` for AI-curated nodes
   * (every required path cited and validated), `GOLDEN_FIXTURE` for Architect-supplied golden records.
   */
  readonly evidenceBasis: 'VERIFIED_CITATIONS' | 'GOLDEN_FIXTURE';
  /** Golden only: required paths not carried by a citation, each with the exact basis of its value. */
  readonly uncitedBasis?: ReadonlyArray<{
    readonly path: string;
    readonly basis: string;
    readonly source: string;
  }>;
}

export interface QuarantineWrite {
  readonly layer: WikiLayer;
  readonly nodeKey: string;
  readonly expectedVersion: number;
  readonly actor: RevisionActor;
  readonly reason: string;
  /** The rejected proposal / evidence, kept in the revision ledger for review. */
  readonly evidence: unknown;
}

export class NodeVersionConflictError extends Error {
  override readonly name = 'NodeVersionConflictError';
  constructor(
    readonly layer: WikiLayer,
    readonly nodeKey: string,
    readonly expectedVersion: number,
  ) {
    super(`${layer} ${nodeKey}: expected version ${expectedVersion} is no longer current`);
  }
}

/** Where a card is stored: the node it was compiled from. */
export interface CardTarget {
  readonly kind: SliceCardKind;
  /** Row id of the node (`program_season_spec.id`, `university.id`, `city_profile.id`, `university_housing.id`). */
  readonly rowId: string;
}

export interface WikiLayerStore {
  findNode<L extends WikiLayer>(layer: L, nodeKey: string): Promise<StoredNode<L> | undefined>;
  writeNode<L extends WikiLayer>(write: NodeWrite<L>): Promise<{ rowId: string; version: number }>;
  /** Marks an existing node QUARANTINED (fields untouched) and records the evidence; returns the new version. */
  quarantineNode(write: QuarantineWrite): Promise<number>;
  /** Records a rejected proposal for a node that does not exist (no row is created). */
  recordRejectedProposal(write: QuarantineWrite): Promise<void>;
  setCard(target: CardTarget, card: SliceCard | null): Promise<void>;
  upsertProgramSearchText(programId: string, searchText: string): Promise<void>;
  /** Housing rows of a university, newest rates season first. */
  listHousing(universityId: string): Promise<StoredNode<'HOUSING'>[]>;
  /** Program specs of a university for one season. */
  listSpecs(universityId: string, season: string): Promise<StoredNode<'PROGRAM_SPEC'>[]>;
}

export interface WikiLayerRepository extends WikiLayerStore {
  /** Runs `work` in one `wiki_writer` transaction (all layer writes + revisions + cards, or none). */
  transaction<T>(work: (store: WikiLayerStore) => Promise<T>): Promise<T>;
  setProgramEmbedding(programId: string, modelId: string, embedding: readonly number[]): Promise<void>;
}

/** A stored `wiki.source_snapshot` row as the curator reads it. */
export interface StoredSnapshot {
  readonly id: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly contentKind: 'HTML' | 'PDF' | 'HTTP_ERROR';
  readonly errorCode: SnapshotErrorCode | null;
  readonly cleanTextBlobRef: string | null;
  readonly discoveredLinks: readonly DiscoveredLink[];
  readonly fetchedAt: string;
}

/** Read access to stored source snapshots of a crawl target (the curator never fetches the web). */
export interface SnapshotReaderPort {
  listTargetSnapshots(
    targetKey: string,
  ): Promise<{ seedUrls: readonly string[]; rows: StoredSnapshot[] } | undefined>;
  readCleanText(blobRef: string): Promise<string>;
}

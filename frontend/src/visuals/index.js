import { AggregatesVisual, CtesVisual, DmlVisual, JoinsVisual, SelectVisual, SubqueriesVisual, UpsertVisual, WindowsVisual } from './QueryVisuals.jsx';
import { FulltextVisual, JsonbVisual, RangesVisual, TypesVisual } from './TypeVisuals.jsx';
import { ConstraintsVisual, FunctionsVisual, PartitioningVisual, TriggersVisual, ViewsVisual } from './SchemaVisuals.jsx';
import { ExplainVisual, IndexesVisual, PgssVisual, StatisticsVisual } from './PerformanceVisuals.jsx';
import { AdvisoryVisual, DeadlocksVisual, IsolationVisual, MvccVisual, RowLocksVisual, SkipLockedVisual, TransactionsVisual } from './ConcurrencyVisuals.jsx';
import { CopyVisual, InjectionVisual, NotifyVisual, RlsVisual, RolesVisual, TrigramVisual, VectorVisual } from './SecurityFeatureVisuals.jsx';
import {
  BackupVisual, IndexNotUsedVisual, MigrationsVisual, MonitoringVisual, NPlusOneVisual, NotInVisual, PaginationVisual, PoolingVisual, ReplicationVisual,
} from './OpsMistakeVisuals.jsx';

// Maps each demo's `visual` name (see demos/catalog.js) to the component that draws its data
export const VISUALS = {
  select: SelectVisual,
  dml: DmlVisual,
  upsert: UpsertVisual,
  joins: JoinsVisual,
  aggregates: AggregatesVisual,
  subqueries: SubqueriesVisual,
  ctes: CtesVisual,
  windows: WindowsVisual,
  types: TypesVisual,
  jsonb: JsonbVisual,
  ranges: RangesVisual,
  fulltext: FulltextVisual,
  constraints: ConstraintsVisual,
  views: ViewsVisual,
  functions: FunctionsVisual,
  triggers: TriggersVisual,
  partitioning: PartitioningVisual,
  explain: ExplainVisual,
  indexes: IndexesVisual,
  statistics: StatisticsVisual,
  pgss: PgssVisual,
  transactions: TransactionsVisual,
  isolation: IsolationVisual,
  'row-locks': RowLocksVisual,
  'skip-locked': SkipLockedVisual,
  deadlocks: DeadlocksVisual,
  advisory: AdvisoryVisual,
  mvcc: MvccVisual,
  roles: RolesVisual,
  rls: RlsVisual,
  injection: InjectionVisual,
  notify: NotifyVisual,
  copy: CopyVisual,
  trigram: TrigramVisual,
  vector: VectorVisual,
  pooling: PoolingVisual,
  monitoring: MonitoringVisual,
  migrations: MigrationsVisual,
  backup: BackupVisual,
  replication: ReplicationVisual,
  'n-plus-one': NPlusOneVisual,
  'not-in': NotInVisual,
  pagination: PaginationVisual,
  'index-not-used': IndexNotUsedVisual,
};

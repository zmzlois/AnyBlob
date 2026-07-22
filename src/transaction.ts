import { DeleteBuilder } from "./builders/delete"
import { InsertBuilder } from "./builders/insert"
import { SelectBuilder } from "./builders/select"
import { UpdateBuilder } from "./builders/update"
import { readTable, replaceTable, withTable } from "./storage"
import type { DbConfig, TableDef, TableSchema, WithTableFn } from "./types"

interface Snapshot {
  data: unknown[]
  etag: string | null
}

export class TransactionDb {
  private readonly snapshots = new Map<string, Snapshot>()

  constructor(private readonly config: DbConfig) {}

  private async ensureSnapshot(tableName: string): Promise<void> {
    if (this.snapshots.has(tableName)) return
    const { data, etag } = await readTable<unknown>(tableName, this.config)
    this.snapshots.set(tableName, { data: [...data], etag })
  }

  readonly withTableFn: WithTableFn = async <T>(
    tableName: string,
    transform: (rows: T[]) => T[],
  ) => {
    await this.ensureSnapshot(tableName)
    return withTable<T>(
      tableName,
      this.config,
      transform,
      this.config.maxRetries,
    )
  }

  async rollback(): Promise<void> {
    await Promise.all(
      Array.from(this.snapshots.entries()).map(([tableName, { data }]) =>
        replaceTable(tableName, data, this.config),
      ),
    )
  }

  select(fields?: Record<string, unknown>) {
    return new SelectBuilder(this.config, fields)
  }

  insert<S extends TableSchema>(table: TableDef<S>) {
    return new InsertBuilder(table, this.withTableFn)
  }

  update<S extends TableSchema>(table: TableDef<S>) {
    return new UpdateBuilder(table, this.withTableFn)
  }

  delete<S extends TableSchema>(table: TableDef<S>) {
    return new DeleteBuilder(table, this.withTableFn)
  }
}

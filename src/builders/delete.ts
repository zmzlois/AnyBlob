import { matchesCondition } from "../filter"
import type { Condition, InferRow, TableSchema } from "../types"
import { WriteBuilder } from "./base"

export class DeleteBuilder<
  S extends TableSchema,
  TReturn = void,
> extends WriteBuilder<S, TReturn> {
  private _condition?: Condition

  where(condition: Condition): this {
    this._condition = condition
    return this
  }

  protected async _execute(): Promise<TReturn> {
    let deleted: InferRow<S>[] = []

    await this._withTable<InferRow<S>>(this.table._name, (rows) => {
      deleted = []
      return rows.filter((row) => {
        if (
          !this._condition ||
          matchesCondition(row as Record<string, unknown>, this._condition)
        ) {
          deleted.push(row)
          return false
        }
        return true
      })
    })

    return (this._shouldReturn ? deleted : undefined) as TReturn
  }
}

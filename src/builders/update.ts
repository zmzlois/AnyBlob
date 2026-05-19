import { matchesCondition } from "../filter"
import type { Condition, InferRow, TableSchema } from "../types"
import { WriteBuilder } from "./base"

export class UpdateBuilder<
  S extends TableSchema,
  TReturn = void,
> extends WriteBuilder<S, TReturn> {
  private _updates: Partial<InferRow<S>> = {}
  private _condition?: Condition

  set(updates: Partial<InferRow<S>>): this {
    this._updates = updates
    return this
  }

  where(condition: Condition): this {
    this._condition = condition
    return this
  }

  protected async _execute(): Promise<TReturn> {
    let updated: InferRow<S>[] = []

    await this._withTable<InferRow<S>>(this.table._name, (rows) => {
      updated = []
      return rows.map((row) => {
        if (
          !this._condition ||
          matchesCondition(row as Record<string, unknown>, this._condition)
        ) {
          const next = { ...row, ...this._updates } as InferRow<S>
          updated.push(next)
          return next
        }
        return row
      })
    })

    return (this._shouldReturn ? updated : undefined) as TReturn
  }
}

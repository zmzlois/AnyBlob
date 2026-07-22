// shared conflict error so withTable can retry on any adapter's 412
export function conflictError(): Error & { status: number } {
  const err = new Error(
    "blob-db: write conflict — another write occurred concurrently",
  ) as Error & { status: number }
  err.status = 412
  return err
}

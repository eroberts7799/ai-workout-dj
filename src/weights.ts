// Learned selection weights — mined from real DJ sets by
// analysis/selection_weights.py, served by the dev server. Cached for the
// session; absence (prod build, missing file) degrades to no bonus.

let cache: Record<string, number> | null = null

export async function loadPairWeights(): Promise<Record<string, number>> {
  if (cache) return cache
  try {
    const r = await fetch('/api/weights')
    cache = ((await r.json()) as { pairs?: Record<string, number> }).pairs ?? {}
  } catch {
    cache = {}
  }
  return cache
}

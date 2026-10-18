const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const fields = ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
export function codexCounts(raw) {
  return Object.fromEntries(fields.filter(k => number(raw?.[k]) !== undefined).map(k => [k,raw[k]]));
}
export function codexUsage(raw, baseline) {
  if (!raw) return undefined;
  const sessionTotal = codexCounts(raw.total);
  const result = {provider:'codex',sessionTotal,lastRequest:codexCounts(raw.last)};
  // An unknown baseline must not turn a whole session into one turn's usage.
  if (baseline && Object.keys(sessionTotal).every(k => number(baseline[k]) !== undefined && sessionTotal[k] >= baseline[k])) {
    result.turn = Object.fromEntries(Object.entries(sessionTotal).map(([k,v]) => [k,v-baseline[k]]));
  }
  return result;
}
export function claudeUsage(raw) {
  if (!raw) return undefined;
  const turn = {};
  for (const [to,from] of Object.entries({uncachedInputTokens:'input_tokens',cachedInputTokens:'cache_read_input_tokens',cacheWriteInputTokens:'cache_creation_input_tokens',outputTokens:'output_tokens'})) {
    if (number(raw[from]) !== undefined) turn[to] = raw[from];
  }
  if (['uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens'].every(k => turn[k] !== undefined)) turn.inputTokens = turn.uncachedInputTokens + turn.cachedInputTokens + turn.cacheWriteInputTokens;
  if (turn.inputTokens !== undefined && turn.outputTokens !== undefined) turn.totalTokens = turn.inputTokens + turn.outputTokens;
  return {provider:'claude',turn};
}
export function codexExecUsage(raw, baseline) {
  if (!raw) return undefined;
  return codexUsage({total:codexCounts({inputTokens:raw.input_tokens,cachedInputTokens:raw.cached_input_tokens,outputTokens:raw.output_tokens})},baseline);
}

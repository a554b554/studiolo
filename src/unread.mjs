// Conversations whose agent finished (or now needs an answer) since anyone last looked at them.
// Marks live on the project record so the project list can show them without loading messages,
// and each conversation is its own journal field, so marks and views from different machines
// merge. The map itself is never removed: dropping it could discard a concurrent mark.
export function markUnread(state, run, status = run?.status) {
  if (!run?.sessionId) return;
  (state.project.unread ||= {})[run.sessionId] = {at: new Date().toISOString(), status};
}

// `at` is the mark the viewer saw; a newer mark (the agent finished again meanwhile) stays.
export function markSeen(state, sessionId, at) {
  const entry = state.project.unread?.[sessionId];
  if (!entry || typeof at === 'string' && entry.at > at) return false;
  delete state.project.unread[sessionId];
  return true;
}

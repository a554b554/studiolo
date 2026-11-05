// What the web page loads of a project. The full project view carries every
// conversation's messages, and most of their bytes are tool records (command output, file contents):
// 31 of the 35 MB of the largest project. The page shows one conversation at a time and keeps tool
// records folded in the raw log, so it asks for one conversation (or one Artifact's comment threads)
// and gets the tool records of ended runs as previews; the raw log fetches a run's full records when
// it is opened. Records of executing runs stay whole: the live timeline reads its steps from them.
export const RECORD_PREVIEW = 500;
const executing = run => ['queued', 'running', 'waiting'].includes(run?.status);
// Older residents stored late assistant text as tool records; the page shows those as replies.
const BACKGROUND = 'Background native event: ';

export function compactRecord(message, run) {
  if (message.role !== 'system' || message.kind !== 'tool' || typeof message.text !== 'string') return message;
  if (message.text.length <= RECORD_PREVIEW || message.text.startsWith(BACKGROUND) || executing(run)) return message;
  return { ...message, text: message.text.slice(0, RECORD_PREVIEW), truncated: message.text.length };
}

// `view` is the assembled project view; exactly one of sessionId / artifactId picks the messages.
// `latest` is the conversation the page opens by default: the last one neither archived nor deleted.
export function pageView(view, { sessionId = null, artifactId = null } = {}) {
  if (sessionId === 'latest') sessionId = view.sessions.filter(session => !session.deletedAt && !session.archivedAt).at(-1)?.id || null;
  const runs = new Map(view.runs.map(run => [run.id, run]));
  const wanted = sessionId ? message => message.sessionId === sessionId : message => !message.sessionId && message.artifactId === artifactId;
  const messages = [];
  for (const message of view.messages) if (wanted(message)) messages.push(compactRecord(message, runs.get(message.runId)));
  return { ...view, messages, page: { sessionId, artifactId } };
}

// A run's tool records in full, for the raw log.
export function runRecords(state, runId) {
  return state.messages.filter(message => message.runId === runId && message.role === 'system' && message.kind === 'tool');
}
